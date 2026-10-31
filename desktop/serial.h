#pragma once
#include <QObject>
#include <QSerialPort>
#include <QStringDecoder>
#include <QTimer>

class SerialConnection : public QObject {
    Q_OBJECT
public:
    explicit SerialConnection(QObject* parent = nullptr);
    bool isOpen() const { return port_.isOpen(); }
    bool isSlcan() const { return slcan_; }
    void open(const QString& name, bool slcan, int bitrate);
    void close();
signals:
    void uartText(const QString& text);
    void uartIdle();
    void uartReset();
    void slcanLine(const QString& text);
    void statusChanged(const QString& text);
    void rawText(const QString& text);
private:
    QSerialPort port_;
    QTimer idle_, timeout_, health_;
    QStringDecoder decoder_{QStringDecoder::Utf8};
    QByteArray line_;
    bool slcan_ = false, discarding_ = false;
    int stage_ = -1, bitrateIndex_ = 8;
    void read();
    void acknowledge(bool rejected);
    void command(const QByteArray& text);
};
