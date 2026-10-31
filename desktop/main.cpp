#include "window.h"
#include <QApplication>
#include <QMessageBox>
#include <QDebug>
#include <stdexcept>

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    app.setApplicationName("Formula Lab");
    app.setOrganizationName("TUL Racing");
    const bool smokeTest = app.arguments().contains("--smoke-test");
    try {
        Window window;
        if (smokeTest) {
            window.execute("ignition");
            window.execute("tick", {{"seconds", 0.1}});
            const auto snapshot = window.state();
            const auto vehicle = snapshot["vehicle"].toObject();
            if (!vehicle["engineOn"].toBool() || vehicle["elapsed"].toDouble() <= 0 || snapshot["retained"].toInt() < 3)
                throw std::runtime_error("Desktop startup smoke test failed");
            qInfo("Desktop startup smoke test passed");
            return 0;
        }
        window.show();
        return app.exec();
    } catch (const std::exception& e) {
        if (smokeTest) { qCritical().noquote() << e.what(); return 1; }
        QMessageBox::critical(nullptr, "Formula Lab — chyba spuštění", QString::fromUtf8(e.what()));
        return 1;
    }
}
