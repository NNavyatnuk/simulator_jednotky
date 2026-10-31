#include "window.h"
#include <QApplication>
#include <QMessageBox>

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    app.setApplicationName("Formula Lab");
    app.setOrganizationName("TUL Racing");
    try {
        Window window;
        window.show();
        return app.exec();
    } catch (const std::exception& e) {
        QMessageBox::critical(nullptr, "Formula Lab — chyba spuštění", QString::fromUtf8(e.what()));
        return 1;
    }
}
