#include "window.h"
#include <QApplication>
#include <QCheckBox>
#include <QComboBox>
#include <QDir>
#include <QJsonDocument>
#include <QJsonArray>
#include <QLineEdit>
#include <QLabel>
#include <QPushButton>
#include <QSlider>
#include <QTabWidget>
#include <QTableWidget>
#include <QSignalSpy>
#include <QtTest>
#ifdef Q_OS_LINUX
#include <fcntl.h>
#include <unistd.h>
#include <cstdlib>
#include <termios.h>
#endif

namespace {
const char* validMosfetTelemetry =
    "MOSFET,1,gpio,0,0,0,0\n"
    "MOSFET,1,gpio,1,10000,1,0\n"
    "MOSFET,1,gpio,2,60000,1,0\n"
    "MOSFET,1,gpio,3,110000,0,0\n"
    "MOSFET,1,gpio,4,160000,0,0\n"
    "MOSFET,1,gpio,5,210000,0,0\n"
    "MOSFET,1,gpio,6,260000,0,0\n"
    "MOSFET,1,gpio,7,310000,0,1\n"
    "MOSFET,1,gpio,8,360000,0,0\n";
}

class DesktopTests : public QObject {
    Q_OBJECT
private slots:
    void physicsAndController() {
        Engine e;
        e.call("tick", {{"seconds", 0.25}}); e.call("tick", {{"seconds", 0.1}});
        e.call("ignition"); e.call("request", {{"command", "up"}});
        auto s = e.call("snapshot");
        QVERIFY(s["unit"].toObject()["lastDecision"].toObject()["accepted"].toBool());
        e.call("tick", {{"seconds", 0.2}});
        QCOMPARE(e.call("snapshot")["vehicle"].toObject()["gear"].toInt(), 1);
        e.call("pedals", {{"throttle", 1}, {"clutch", 0}});
        for (int i = 0; i < 40; ++i) e.call("tick", {{"seconds", 0.1}});
        QVERIFY(e.call("snapshot")["vehicle"].toObject()["speedKph"].toDouble() > 15);
        e.call("pedals", {{"throttle", 0}, {"brake", 1}});
        for (int i = 0; i < 40; ++i) e.call("tick", {{"seconds", 0.1}});
        QCOMPARE(e.call("snapshot")["vehicle"].toObject()["speedKph"].toDouble(), 0.0);
        e.call("request", {{"command", "neutral"}}); e.call("tick", {{"seconds", 0.1}});
        QCOMPARE(e.call("snapshot")["vehicle"].toObject()["gear"].toInt(), 0);
        e.call("pause"); const QJsonValue elapsed = e.call("snapshot")["vehicle"].toObject()["elapsed"];
        e.call("tick", {{"seconds", 0.2}}); QCOMPARE(e.call("snapshot")["vehicle"].toObject()["elapsed"], elapsed);
    }

    void serialParserAndCapture() {
        Engine e;
        e.call("serial", {{"text", "ID is 1536\nData byte 0 = 64\nData byte 1 = 3"}});
        e.call("serialIdle"); QCOMPARE(e.call("snapshot")["retained"].toInt(), 0);
        e.call("serial", {{"text", "1\n"}}); e.call("serialIdle");
        auto row = e.call("snapshot")["rows"].toArray().first().toObject();
        QCOMPARE(row["decoded"].toObject()["rpm"].toInt(), 8000);
        QVERIFY(row["dlcInferred"].toBool()); QCOMPARE(row["source"].toString(), "uart");
        e.call("capture"); e.call("serial", {{"text", "ID is 1540\nData byte 0 = 1\n"}}); e.call("serialIdle");
        QCOMPARE(e.call("snapshot")["retained"].toInt(), 1);
        e.call("import", {{"text", "(1700000000) can0 666#0014DC0108000800\n"}});
        row = e.call("snapshot", {{"filter", "666"}, {"direction", "rx"}})["rows"].toArray().first().toObject();
        QCOMPARE(row["decoded"].toObject()["resetFuel"].toInt(), 2);
        QVERIFY(e.call("exportLog")["text"].toString().contains("uart0 600#401F"));
        const QJsonValue before = e.call("snapshot")["retained"];
        QVERIFY_EXCEPTION_THROWN(e.call("import", {{"text", "invalid CAN"}}), std::runtime_error);
        QCOMPARE(e.call("snapshot")["retained"], before);
    }

    void liveMosfetController() {
        Engine e;
        QCOMPARE(e.call("snapshot")["mosfet"].toObject()["status"].toString(), "waiting");
        e.call("tick", {{"seconds", 0.25}}); e.call("tick", {{"seconds", 0.1}});
        e.call("ignition"); e.call("request", {{"command", "up"}});
        QVERIFY(e.call("snapshot")["unit"].toObject()["fet1"].toBool());
        QCOMPARE(e.call("snapshot")["mosfet"].toObject()["received"].toInt(), 0); // model is never USB evidence
        e.call("pause"); e.call("capture");
        const QJsonValue retained = e.call("snapshot")["retained"];
        const QString telemetry = QString::fromLatin1(validMosfetTelemetry);
        e.call("serial", {{"text", telemetry.left(18)}});
        QCOMPARE(e.call("snapshot")["mosfet"].toObject()["received"].toInt(), 0);
        e.call("serial", {{"text", telemetry.mid(18)}});
        auto mosfet = e.call("snapshot")["mosfet"].toObject();
        QCOMPARE(mosfet["status"].toString(), "pass");
        QCOMPARE(mosfet["scope"].toString(), "gpio");
        QCOMPARE(mosfet["received"].toInt(), 9);
        const auto channels = mosfet["channels"].toArray();
        QCOMPARE(channels[0].toObject()["durationsMs"].toArray().last().toDouble(), 100.0);
        QCOMPARE(channels[1].toObject()["durationsMs"].toArray().last().toDouble(), 50.0);
        QCOMPARE(e.call("snapshot")["retained"], retained); // capture pause does not stop diagnostics
        e.call("reset"); // model reset does not erase hardware evidence
        QCOMPARE(e.call("snapshot")["mosfet"].toObject()["received"].toInt(), 9);
        e.call("serialReset");
        QCOMPARE(e.call("snapshot")["mosfet"].toObject()["status"].toString(), "disconnected");
        e.call("mosfetReset");
        QCOMPARE(e.call("snapshot")["mosfet"].toObject()["received"].toInt(), 0);
        QCOMPARE(e.call("snapshot")["mosfet"].toObject()["status"].toString(), "waiting");
    }

    void liveMosfetWidgets() {
        Window window; window.show();
        auto* tabs = window.findChild<QTabWidget*>("mainTabs"); QVERIFY(tabs);
        int diagnosticTab = -1;
        for (int i = 0; i < tabs->count(); ++i) if (tabs->tabText(i) == "MOSFET výstupy") diagnosticTab = i;
        QVERIFY(diagnosticTab >= 0); tabs->setCurrentIndex(diagnosticTab);
        auto* source = window.findChild<QLabel*>("mosfetSource"); QVERIFY(source);
        QVERIFY(source->text().contains("žádná telemetrie"));
        window.execute("serial", {{"text", QString::fromLatin1(validMosfetTelemetry)}});
        QCOMPARE(window.state()["mosfet"].toObject()["status"].toString(), "pass");
        QVERIFY(source->text().contains("registru GPIO"));
        QVERIFY(source->text().contains("není změřeno"));
        auto* channels = window.findChild<QTableWidget*>("mosfetChannels"); QVERIFY(channels);
        QCOMPARE(channels->item(0, 2)->text(), "1");
        QCOMPARE(channels->item(0, 3)->text(), "100.0");
        auto* reset = window.findChild<QPushButton*>("mosfetReset"); QVERIFY(reset);
        QTest::mouseClick(reset, Qt::LeftButton);
        QCOMPARE(window.state()["mosfet"].toObject()["received"].toInt(), 0);
        QVERIFY(source->text().contains("žádná telemetrie"));
        window.execute("serial", {{"text", "MOSFET,1,gpio,0,0,1,1\n"}});
        QCOMPARE(window.state()["mosfet"].toObject()["status"].toString(), "fail");
        QVERIFY(window.findChild<QLabel*>("mosfetStatus")->styleSheet().contains("#d44b42"));
        window.close();
    }

    void calibrationAndProfiles() {
        Engine e;
        const auto original = e.call("calibration");
        auto invalid = original; auto vehicle = invalid["vehicle"].toObject(); vehicle["massKg"] = -5; invalid["vehicle"] = vehicle;
        QVERIFY_EXCEPTION_THROWN(e.call("configure", invalid), std::runtime_error);
        QCOMPARE(e.call("calibration"), original);
        auto next = original; vehicle = next["vehicle"].toObject(); vehicle["massKg"] = 340; next["vehicle"] = vehicle;
        e.call("configure", next); QCOMPARE(e.call("calibration")["vehicle"].toObject()["massKg"].toInt(), 340);
        QJsonObject profile{{"name", "Custom"}, {"bitrate", 250000}, {"frames", QJsonArray{
            QJsonObject{{"name", "RPM"}, {"id", 0x321}, {"dlc", 2}, {"trigger", "periodic"}, {"periodMs", 50},
                {"signals", QJsonArray{QJsonObject{{"name", "rpm"}, {"source", "rpm"}, {"startByte", 0}, {"byteLength", 2}}}}}}}};
        e.call("profile", profile); e.call("tick", {{"seconds", 0.1}});
        QVERIFY(!e.call("snapshot", {{"filter", "321"}})["rows"].toArray().isEmpty());
        const auto exported = e.call("exportJson"); QVERIFY(!exported["frames"].toArray().isEmpty());
        e.call("defaultProfile"); e.call("mode", {{"mode", "firmware-parser"}});
        e.call("ignition"); e.call("tick", {{"seconds", 0.25}}); e.call("tick", {{"seconds", 0.1}});
        e.call("request", {{"command", "up"}}); QCOMPARE(e.call("snapshot")["vehicle"].toObject()["gear"].toInt(), 0);
    }

    void nativeWidgets() {
        Window window; window.show();
        auto* ignition = window.findChild<QPushButton*>("ignition"); QVERIFY(ignition);
        QTest::mouseClick(ignition, Qt::LeftButton);
        QVERIFY(window.state()["vehicle"].toObject()["engineOn"].toBool());
        QTest::qWait(350);
        QTest::mouseClick(window.findChild<QPushButton*>("shiftUp"), Qt::LeftButton);
        QTRY_COMPARE(window.state()["vehicle"].toObject()["gear"].toInt(), 1);
        window.findChild<QSlider*>("clutch")->setValue(0);
        window.findChild<QSlider*>("throttle")->setValue(100);
        QTRY_VERIFY_WITH_TIMEOUT(window.state()["vehicle"].toObject()["speedKph"].toDouble() > 5, 5000);
        window.execute("import", {{"text", "(1700000000) can0 123#AABB\n"}});
        window.findChild<QLineEdit*>("canFilter")->setText("123");
        QTRY_COMPARE(window.findChild<QTableWidget*>("canLog")->rowCount(), 1);
        QTest::mouseClick(window.findChild<QPushButton*>("reset"), Qt::LeftButton);
        QCOMPARE(window.findChild<QSlider*>("throttle")->value(), 0);
        QCOMPARE(window.state()["vehicle"].toObject()["gear"].toInt(), 0);
        QDir().mkpath("artifacts");
        QVERIFY(window.grab().save("artifacts/desktop-dashboard.png"));
        window.resize(820, 650); window.close();
    }

    void serialPortFailure() {
        SerialConnection serial; QSignalSpy status(&serial, &SerialConnection::statusChanged);
        serial.open("nonexistent-desktop-test-port", false, 1000000);
        QVERIFY(!serial.isOpen()); QVERIFY(!status.isEmpty());
        serial.close(); serial.close();
    }

#ifdef Q_OS_LINUX
    void actualSerialTransport() {
        const int master = posix_openpt(O_RDWR | O_NOCTTY | O_NONBLOCK); QVERIFY(master >= 0);
        QVERIFY(grantpt(master) == 0); QVERIFY(unlockpt(master) == 0);
        const auto name = QString::fromLocal8Bit(ptsname(master));
        SerialConnection serial; Engine engine;
        QSignalSpy raw(&serial, &SerialConnection::rawText);
        QSignalSpy parsed(&serial, &SerialConnection::uartText);
        connect(&serial, &SerialConnection::uartText, this, [&](const QString& text) { engine.call("serial", {{"text", text}}); });
        connect(&serial, &SerialConnection::uartIdle, this, [&] { engine.call("serialIdle"); });
        connect(&serial, &SerialConnection::uartReset, this, [&] { engine.call("serialReset"); });
        serial.open(name, false, 1000000); QVERIFY(serial.isOpen());
        termios settings{}; QVERIFY(tcgetattr(master, &settings) == 0);
        QCOMPARE(cfgetispeed(&settings), B115200);
        QCOMPARE(cfgetospeed(&settings), B115200);
        // Split a UTF-8 character between real serial reads; raw and parsed
        // subscribers must receive exactly the same decoded stream.
        QCOMPARE(::write(master, "\xC5", 1), 1); QTRY_COMPARE(raw.size(), 1);
        QCOMPARE(::write(master, "\x99\n", 2), 2); QTRY_COMPARE(raw.size(), 2);
        QCOMPARE(raw.last().first().toString(), QString::fromUtf8("ř\n"));
        QCOMPARE(parsed.last().first().toString(), raw.last().first().toString());
        const QByteArray sample("ID is 1536\nData byte 0 = 64\nData byte 1 = 31\n");
        QCOMPARE(::write(master, sample.constData(), static_cast<size_t>(sample.size())), sample.size());
        QTRY_COMPARE(engine.call("snapshot")["retained"].toInt(), 1);
        QCOMPARE(engine.call("snapshot")["rows"].toArray().first().toObject()["decoded"].toObject()["rpm"].toInt(), 8000);
        const QByteArray shortCan("ID is 1540\nData byte 0 = 2\n");
        QCOMPARE(::write(master, shortCan.constData(), static_cast<size_t>(shortCan.size())), shortCan.size());
        // Telemetry stays active faster than the serial idle timeout. The
        // short CAN record must nevertheless become visible while connected.
        for (int i = 0; i < 8; ++i) {
            const auto heartbeat = QString("MOSFET,1,gpio,%1,%2,0,0\n").arg(i).arg(i * 45000).toLatin1();
            QCOMPARE(::write(master, heartbeat.constData(), static_cast<size_t>(heartbeat.size())), heartbeat.size());
            QTest::qWait(45);
        }
        QVERIFY(serial.isOpen());
        QCOMPARE(engine.call("snapshot")["retained"].toInt(), 2);
        const auto gearRows = engine.call("snapshot", {{"filter", "604"}})["rows"].toArray();
        QCOMPARE(gearRows.size(), 1);
        QCOMPARE(gearRows.first().toObject()["decoded"].toObject()["gear"].toInt(), 2);
        engine.call("mosfetReset");
        engine.call("pause"); engine.call("capture");
        const QByteArray outputs(validMosfetTelemetry);
        QCOMPARE(::write(master, outputs.constData(), static_cast<size_t>(outputs.size())), outputs.size());
        QTRY_COMPARE(engine.call("snapshot")["mosfet"].toObject()["status"].toString(), "pass");
        QCOMPARE(engine.call("snapshot")["mosfet"].toObject()["received"].toInt(), 9);
        QCOMPARE(engine.call("snapshot")["retained"].toInt(), 2);
        char buffer[64]; QVERIFY(::read(master, buffer, sizeof(buffer)) <= 0); // no UART writes
        serial.close(); QVERIFY(!serial.isOpen());
        QCOMPARE(engine.call("snapshot")["mosfet"].toObject()["status"].toString(), "disconnected");
        serial.open(name, false, 1000000); QVERIFY(serial.isOpen());
        ::close(master); QTRY_VERIFY(!serial.isOpen());
    }

    void slcanListenOnlyHandshake() {
        const int master = posix_openpt(O_RDWR | O_NOCTTY | O_NONBLOCK); QVERIFY(master >= 0);
        QVERIFY(grantpt(master) == 0); QVERIFY(unlockpt(master) == 0);
        SerialConnection serial;
        QSignalSpy frames(&serial, &SerialConnection::slcanLine);
        QSignalSpy status(&serial, &SerialConnection::statusChanged);
        QByteArray received;
        const auto drain = [&] {
            char bytes[256]; const auto size = ::read(master, bytes, sizeof(bytes));
            if (size > 0) received.append(bytes, size);
            return received;
        };
        serial.open(QString::fromLocal8Bit(ptsname(master)), true, 1000000);
        QVERIFY(serial.isOpen());
        QTRY_COMPARE(drain(), QByteArray("C\r")); received.clear();
        QCOMPARE(::write(master, "\r", 1), 1);
        QTRY_COMPARE(drain(), QByteArray("S8\r")); received.clear();
        QCOMPARE(::write(master, "\r", 1), 1);
        QTRY_COMPARE(drain(), QByteArray("L\r")); received.clear();
        QCOMPARE(::write(master, "\r", 1), 1);
        QTRY_VERIFY(status.last().first().toString().contains("listen-only"));
        const QByteArray frame("t6002401F\r");
        QCOMPARE(::write(master, frame.constData(), static_cast<size_t>(frame.size())), frame.size());
        QTRY_COMPARE(frames.size(), 1);
        QCOMPARE(frames.first().first().toString(), "t6002401F");
        QVERIFY(drain().isEmpty()); // no active-open command or CAN transmission
        serial.close();
        serial.open(QString::fromLocal8Bit(ptsname(master)), true, 1000000);
        QTRY_VERIFY(drain().endsWith("C\r")); received.clear();
        // A command with no acknowledgement must time out and close the port.
        QTRY_VERIFY_WITH_TIMEOUT(!serial.isOpen(), 3000);
        QVERIFY(status.last().first().toString().contains("nepotvrdil"));
        ::close(master);
    }
#endif
};

QTEST_MAIN(DesktopTests)
#include "tests.moc"
