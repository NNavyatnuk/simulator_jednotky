#pragma once
#include "engine.h"
#include "serial.h"
#include <QMainWindow>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QMap>
#include <functional>

class QLabel;
class QSlider;
class QPushButton;
class QComboBox;
class QCheckBox;
class QLineEdit;
class QTableWidget;
class QPlainTextEdit;
class QProgressBar;
class Telemetry;

class Window : public QMainWindow {
    Q_OBJECT
public:
    Window();
    QJsonObject state();
    QJsonObject execute(const QString& command, const QJsonObject& args = {});
protected:
    bool eventFilter(QObject*, QEvent*) override;
    void closeEvent(QCloseEvent*) override;
private:
    Engine engine_;
    SerialConnection serial_;
    QElapsedTimer elapsed_;
    QTimer timer_;
    QLabel *rpm_, *speed_, *gear_, *coolant_, *unit_, *message_, *connection_, *count_, *profile_;
    QProgressBar* rpmBar_;
    QMap<QString, QSlider*> pedals_;
    QMap<QString, QLabel*> pedalValues_;
    QMap<int, int> held_;
    QString error_;
    QPushButton *ignition_, *pause_, *capture_, *connect_, *disconnect_, *refresh_;
    QComboBox *ports_, *transport_, *direction_, *mode_;
    QCheckBox* between_;
    QLineEdit* filter_;
    QTableWidget* log_;
    QPlainTextEdit* raw_;
    Telemetry* chart_;
    void render();
    void refreshPorts();
    void releaseKeys();
    void importFile(const QString& kind);
    void exportFile(const QString& kind, const QString& filename);
    void editCalibration();
    void guard(const std::function<void()>& operation);
};
