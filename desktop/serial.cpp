#include "serial.h"
#include <array>
#include <algorithm>
#ifdef Q_OS_UNIX
#include <poll.h>
#endif

SerialConnection::SerialConnection(QObject* parent) : QObject(parent) {
    idle_.setSingleShot(true);
    idle_.setInterval(150);
    timeout_.setSingleShot(true);
    timeout_.setInterval(1800);
    // Qt does not report EOF for every Unix tty/PTY backend. Poll only hangup
    // flags without consuming bytes; Windows USB removal uses errorOccurred.
    health_.setInterval(100);
    connect(&health_, &QTimer::timeout, this, [this] {
#ifdef Q_OS_UNIX
        if (!port_.isOpen()) return;
        pollfd fd{static_cast<int>(port_.handle()), 0, 0};
        if (::poll(&fd, 1, 0) > 0 && (fd.revents & (POLLHUP | POLLERR | POLLNVAL))) {
            close(); emit statusChanged("Sériové zařízení bylo odpojeno.");
        }
#endif
    });
    connect(&idle_, &QTimer::timeout, this, &SerialConnection::uartIdle);
    connect(&timeout_, &QTimer::timeout, this, [this] {
        close(); emit statusChanged("Adaptér nepotvrdil SLCAN příkaz. Je vyžadován režim listen-only L.");
    });
    connect(&port_, &QSerialPort::readyRead, this, &SerialConnection::read);
    connect(&port_, &QSerialPort::errorOccurred, this, [this](QSerialPort::SerialPortError error) {
        if (!port_.isOpen() || (error != QSerialPort::ResourceError && error != QSerialPort::DeviceNotFoundError &&
            error != QSerialPort::PermissionError && error != QSerialPort::ReadError && error != QSerialPort::WriteError &&
            error != QSerialPort::UnknownError)) return;
        const auto message = port_.errorString();
        close(); emit statusChanged("Sériové spojení přerušeno: " + message);
    });
}

void SerialConnection::open(const QString& name, bool slcan, int bitrate) {
    if (port_.isOpen()) { emit statusChanged("Nejprve odpojte aktuální port."); return; }
    if (name.isEmpty()) { emit statusChanged("Vyberte sériový port."); return; }
    constexpr std::array<int, 9> bitrates{10000, 20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000};
    const auto found = std::find(bitrates.begin(), bitrates.end(), bitrate);
    if (slcan && found == bitrates.end()) { emit statusChanged("Nepodporovaný SLCAN bitrate."); return; }
    bitrateIndex_ = static_cast<int>(found - bitrates.begin());
    slcan_ = slcan;
    stage_ = -1; line_.clear(); discarding_ = false;
    decoder_.resetState();
    emit uartReset();
    port_.setPortName(name);
    port_.setReadBufferSize(65536);
    port_.setBaudRate(115200);
    port_.setDataBits(QSerialPort::Data8);
    port_.setParity(QSerialPort::NoParity);
    port_.setStopBits(QSerialPort::OneStop);
    port_.setFlowControl(QSerialPort::NoFlowControl);
    // UART debug must never acquire a writable channel or send CAN commands.
    if (!port_.open(slcan ? QIODevice::ReadWrite : QIODevice::ReadOnly)) {
        emit statusChanged("Port nelze otevřít: " + port_.errorString()); return;
    }
    health_.start();
    // Explicitly avoid asserted handshake lines; some USB drivers may still
    // toggle lines during open. No firmware upload or serial commands in UART.
    port_.setDataTerminalReady(false);
    port_.setRequestToSend(false);
    if (slcan) {
        stage_ = 0;
        emit statusChanged("SLCAN: čekám na potvrzení C / bitrate / L…");
        command("C");
    } else emit statusChanged("Připojeno · " + name + " · 115200 8N1 · USB debug, pouze čtení");
}

void SerialConnection::command(const QByteArray& text) {
    if (!port_.isOpen() || !slcan_) return;
    if (port_.write(text + '\r') < 0) { close(); emit statusChanged("Nelze zapsat SLCAN příkaz."); return; }
    timeout_.start();
}

void SerialConnection::acknowledge(bool rejected) {
    if (stage_ < 0 || stage_ > 2) return;
    timeout_.stop();
    if (rejected && stage_ != 0) {
        close(); emit statusChanged("Adaptér odmítl příkaz. Listen-only L je povinné; aktivní O se nepoužívá."); return;
    }
    ++stage_;
    if (stage_ == 1) command("S" + QByteArray::number(bitrateIndex_));
    else if (stage_ == 2) command("L");
    else emit statusChanged("Připojeno · SLCAN listen-only · 115200 8N1");
}

void SerialConnection::read() {
    const auto bytes = port_.readAll();
    const QString text = decoder_(bytes);
    emit rawText(text);
    if (!slcan_) { emit uartText(text); idle_.start(); return; }
    for (const auto byte : bytes) {
        if (byte == '\a') { line_.clear(); discarding_ = false; acknowledge(true); }
        else if (byte == '\r') {
            if (!discarding_) {
                if (line_.isEmpty()) acknowledge(false);
                else if (stage_ == 3) emit slcanLine(QString::fromLatin1(line_));
            }
            line_.clear(); discarding_ = false;
        } else if (byte != '\n' && !discarding_) {
            line_.append(byte);
            if (line_.size() > 4096) { line_.clear(); discarding_ = true; }
        }
        if (!port_.isOpen()) break;
    }
}

void SerialConnection::close() {
    idle_.stop(); timeout_.stop(); health_.stop();
    const bool wasOpen = port_.isOpen();
    stage_ = -1;
    if (wasOpen) {
        if (slcan_) port_.write("C\r");
        port_.close();
    }
    line_.clear(); decoder_.resetState();
    emit uartReset();
    if (wasOpen) emit statusChanged("Odpojeno.");
}
