#include "window.h"
#include <QApplication>
#include <QCheckBox>
#include <QCloseEvent>
#include <QComboBox>
#include <QDateTime>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFile>
#include <QFileDialog>
#include <QFormLayout>
#include <QGroupBox>
#include <QHeaderView>
#include <QJsonDocument>
#include <QKeyEvent>
#include <QLabel>
#include <QLineEdit>
#include <QMessageBox>
#include <QPainter>
#include <QPainterPath>
#include <QPlainTextEdit>
#include <QProgressBar>
#include <QPushButton>
#include <QSaveFile>
#include <QSerialPortInfo>
#include <QSignalBlocker>
#include <QSlider>
#include <QSplitter>
#include <QTabWidget>
#include <QTableWidget>
#include <QTextBlock>
#include <QTimeZone>
#include <QVBoxLayout>
#include <algorithm>
#include <cmath>

class Telemetry : public QWidget {
public:
    QJsonArray history;
    double redline = 14000, now = 0;
    explicit Telemetry(QWidget* parent = nullptr) : QWidget(parent) { setMinimumHeight(170); }
    void paintEvent(QPaintEvent*) override {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const QRectF plot(55, 25, std::max(1, width() - 75), std::max(1, height() - 55));
        p.fillRect(rect(), QColor("#16212f"));
        p.setPen(QColor("#8494a9"));
        p.drawText(12, 17, QString("RPM 0–%1 (oranžová) / km/h 0–250 (tyrkysová) · posledních 30 s").arg(redline));
        for (int i = 0; i <= 4; ++i) {
            const auto y = plot.top() + plot.height() * i / 4;
            p.setPen(QColor("#304156")); p.drawLine(QPointF(plot.left(), y), QPointF(plot.right(), y));
        }
        p.setClipRect(plot);
        for (const auto& key : {QString("rpm"), QString("speedKph")}) {
            QPainterPath path;
            bool first = true;
            for (const auto point : history) {
                const auto o = point.toObject();
                const QPointF v(plot.left() + plot.width() * (1 - (now - o["time"].toDouble()) / 30),
                    plot.bottom() - plot.height() * std::clamp(o[key].toDouble() / (key == "rpm" ? redline : 250), 0.0, 1.0));
                if (first) path.moveTo(v); else path.lineTo(v);
                first = false;
            }
            p.setPen(QPen(QColor(key == "rpm" ? "#ff9955" : "#6bdac7"), 2));
            p.drawPath(path);
        }
        p.setClipping(false); p.setPen(QColor("#8494a9"));
        p.drawText(55, height() - 8, "−30 s"); p.drawText(width() - 50, height() - 8, "nyní");
    }
};

namespace {
QPushButton* button(const QString& text, QBoxLayout* layout, const QString& name = {}) {
    auto* b = new QPushButton(text); b->setObjectName(name); layout->addWidget(b); return b;
}
QString hex(quint32 number, int width) { return QString::number(number, 16).rightJustified(width, '0').toUpper(); }
QString json(const QJsonObject& o) { return QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Indented)); }
}

Window::Window() {
    setWindowTitle("Formula Lab · TUL Racing · desktop");
    resize(1250, 900);
    setMinimumSize(820, 650);
    auto* central = new QWidget;
    auto* layout = new QVBoxLayout(central);
    auto* title = new QLabel("Formula Lab — simulátor řadicí jednotky");
    QFont titleFont = title->font(); titleFont.setPointSize(19); titleFont.setBold(true); title->setFont(titleFont);
    layout->addWidget(title);
    auto* note = new QLabel("Demonstrační fyzika · příkazy DOWN=1 / UP=2 / N=0x40 a maska 0x43 jsou neověřený předpoklad.\nUSB debug pouze monitoruje. Simulované pádlo ani ventil nic nevysílá do skutečné jednotky.");
    note->setWordWrap(true); layout->addWidget(note);
    auto* hardware = new QGroupBox("USB jednotky / CAN adaptér");
    auto* hw = new QVBoxLayout(hardware);
    auto* row = new QHBoxLayout;
    transport_ = new QComboBox; transport_->setObjectName("transport");
    transport_->addItems({"USB jednotky · debug UART", "Externí SLCAN · listen-only"});
    ports_ = new QComboBox; ports_->setObjectName("ports"); ports_->setMinimumContentsLength(25);
    row->addWidget(transport_); row->addWidget(ports_, 1);
    refresh_ = button("Obnovit porty", row, "refreshPorts");
    connect_ = button("Připojit", row, "connectSerial");
    disconnect_ = button("Odpojit", row, "disconnectSerial");
    hw->addLayout(row);
    connection_ = new QLabel("Nepřipojeno · 115200 baud, 8N1"); connection_->setObjectName("connectionStatus");
    connection_->setTextFormat(Qt::PlainText);
    connection_->setWordWrap(true); hw->addWidget(connection_); layout->addWidget(hardware);
    auto* tabs = new QTabWidget; layout->addWidget(tabs, 1);
    auto* dashboard = new QWidget;
    auto* dash = new QVBoxLayout(dashboard);
    auto* values = new QHBoxLayout;
    const QList<QPair<QString, QLabel**>> labels = {{"OTÁČKY / min", &rpm_}, {"RYCHLOST km/h", &speed_}, {"STUPEŇ", &gear_}, {"CHLADICÍ KAPALINA °C", &coolant_}};
    for (const auto& item : labels) {
        auto* box = new QGroupBox(item.first); auto* b = new QVBoxLayout(box);
        *item.second = new QLabel("0"); auto f = (*item.second)->font(); f.setPointSize(30); f.setBold(true); (*item.second)->setFont(f);
        b->addWidget(*item.second); values->addWidget(box);
    }
    rpm_->setObjectName("rpm"); speed_->setObjectName("speed"); gear_->setObjectName("gear");
    dash->addLayout(values);
    rpmBar_ = new QProgressBar; rpmBar_->setTextVisible(false); dash->addWidget(rpmBar_);
    auto* controls = new QHBoxLayout;
    ignition_ = button("Nastartovat [I]", controls, "ignition");
    auto* down = button("Dolů [Q]", controls, "shiftDown");
    auto* neutral = button("Neutrál [N]", controls, "neutral");
    auto* up = button("Nahoru [E]", controls, "shiftUp");
    pause_ = button("Pozastavit", controls, "pause");
    auto* reset = button("Reset", controls, "reset"); dash->addLayout(controls);
    for (const auto& name : {QString("throttle"), QString("brake"), QString("clutch")}) {
        auto* pedalRow = new QHBoxLayout;
        pedalRow->addWidget(new QLabel(name == "throttle" ? "Plyn [mezerník]" : name == "brake" ? "Brzda [B]" : "Spojka [C]"));
        auto* slider = new QSlider(Qt::Horizontal); slider->setObjectName(name); slider->setRange(0, 100); slider->setValue(name == "clutch" ? 100 : 0);
        auto* value = new QLabel(QString::number(slider->value()) + " %"); value->setMinimumWidth(45);
        pedalRow->addWidget(slider, 1); pedalRow->addWidget(value); dash->addLayout(pedalRow); pedals_[name] = slider; pedalValues_[name] = value;
        connect(slider, &QSlider::valueChanged, this, [this, name, value](int v) {
            value->setText(QString::number(v) + " %"); guard([&] { engine_.call("pedals", {{name, v / 100.0}}); });
        });
    }
    auto* unitRow = new QHBoxLayout;
    mode_ = new QComboBox; mode_->setObjectName("unitMode"); mode_->addItems({"Letos · ochrany řazení", "Původní parser · diagnostika"}); unitRow->addWidget(mode_);
    between_ = new QCheckBox("Test čidla: mezi stupni (7)"); between_->setObjectName("sensorBetween"); unitRow->addWidget(between_);
    auto* calibration = button("Model / kalibrace…", unitRow, "calibration"); dash->addLayout(unitRow);
    unit_ = new QLabel; unit_->setObjectName("unitStatus"); unit_->setWordWrap(true); dash->addWidget(unit_);
    chart_ = new Telemetry; dash->addWidget(chart_, 1);
    tabs->addTab(dashboard, "Simulace");

    auto* monitor = new QWidget; auto* mon = new QVBoxLayout(monitor);
    auto* filters = new QHBoxLayout;
    filter_ = new QLineEdit; filter_->setObjectName("canFilter"); filter_->setPlaceholderText("Filtr CAN ID nebo hex dat"); filters->addWidget(filter_, 1);
    direction_ = new QComboBox; direction_->addItems({"Vše", "SIM TX", "Příjem / import"}); filters->addWidget(direction_);
    capture_ = button("Pozastavit záznam", filters, "capturePause"); auto* clear = button("Vymazat", filters, "clearLog"); mon->addLayout(filters);
    count_ = new QLabel; mon->addWidget(count_);
    log_ = new QTableWidget(0, 6); log_->setObjectName("canLog");
    log_->setHorizontalHeaderLabels({"UTC", "Zdroj / rozhraní", "CAN ID", "DLC", "Data", "Dekódováno"});
    log_->setEditTriggers(QAbstractItemView::NoEditTriggers); log_->setSelectionBehavior(QAbstractItemView::SelectRows);
    log_->verticalHeader()->hide(); log_->horizontalHeader()->setStretchLastSection(true);
    log_->setColumnWidth(0, 105); log_->setColumnWidth(1, 145); log_->setColumnWidth(2, 100); log_->setColumnWidth(3, 45); log_->setColumnWidth(4, 200);
    mon->addWidget(log_, 1);
    auto* files = new QHBoxLayout;
    auto* load = button("Import candump / UART…", files);
    auto* save = button("Export candump…", files);
    auto* saveJson = button("Export JSON…", files); mon->addLayout(files);
    profile_ = new QLabel; profile_->setTextFormat(Qt::PlainText); profile_->setWordWrap(true); mon->addWidget(profile_);
    auto* profiles = new QHBoxLayout;
    auto* loadProfile = button("Načíst profil…", profiles);
    auto* saveProfile = button("Export profilu…", profiles);
    auto* defaultProfile = button("Obnovit profil TUL", profiles); mon->addLayout(profiles);
    auto* provenance = new QLabel("UART RX* = rekonstrukce debug textu; DLC je odvozené, čas je přijetí na PC.\nSOUBOR = import; rozhraní v souboru samo nepotvrzuje původ. Záznam uchovává 5000 rámců, tabulka posledních 200 dle filtru.");
    provenance->setWordWrap(true); mon->addWidget(provenance); tabs->addTab(monitor, "CAN monitor");
    raw_ = new QPlainTextEdit; raw_->setObjectName("serialRaw"); raw_->setReadOnly(true); raw_->setMaximumBlockCount(1000);
    tabs->addTab(raw_, "Sériový debug výpis");
    message_ = new QLabel; message_->setObjectName("message"); message_->setTextFormat(Qt::PlainText); message_->setWordWrap(true); message_->setTextInteractionFlags(Qt::TextSelectableByMouse); layout->addWidget(message_);
    setCentralWidget(central);

    connect(ignition_, &QPushButton::clicked, this, [this] { execute("ignition"); });
    connect(up, &QPushButton::clicked, this, [this] { execute("request", {{"command", "up"}}); });
    connect(down, &QPushButton::clicked, this, [this] { execute("request", {{"command", "down"}}); });
    connect(neutral, &QPushButton::clicked, this, [this] { execute("request", {{"command", "neutral"}}); });
    connect(pause_, &QPushButton::clicked, this, [this] { releaseKeys(); execute("pause"); });
    connect(reset, &QPushButton::clicked, this, [this] { releaseKeys(); execute("reset"); });
    connect(capture_, &QPushButton::clicked, this, [this] { execute("capture"); });
    connect(clear, &QPushButton::clicked, this, [this] { execute("clear"); });
    connect(between_, &QCheckBox::toggled, this, [this](bool b) { execute("between", {{"value", b}}); });
    connect(mode_, &QComboBox::currentIndexChanged, this, [this](int index) { releaseKeys(); execute("mode", {{"mode", index ? "firmware-parser" : "reference"}}); });
    connect(calibration, &QPushButton::clicked, this, &Window::editCalibration);
    connect(load, &QPushButton::clicked, this, [this] { importFile("import"); });
    connect(save, &QPushButton::clicked, this, [this] { exportFile("exportLog", "can-zaznam.log"); });
    connect(saveJson, &QPushButton::clicked, this, [this] { exportFile("exportJson", "can-zaznam.json"); });
    connect(loadProfile, &QPushButton::clicked, this, [this] { importFile("profile"); });
    connect(saveProfile, &QPushButton::clicked, this, [this] { exportFile("exportProfile", "can-profil.json"); });
    connect(defaultProfile, &QPushButton::clicked, this, [this] { if (!serial_.isOpen()) execute("defaultProfile"); else { error_ = "Před změnou profilu odpojte port."; render(); } });
    connect(refresh_, &QPushButton::clicked, this, &Window::refreshPorts);
    connect(connect_, &QPushButton::clicked, this, [this] {
        guard([&] { const auto p = engine_.call("exportProfile"); serial_.open(ports_->currentData().toString(), transport_->currentIndex() == 1, p["bitrate"].toInt()); });
    });
    connect(disconnect_, &QPushButton::clicked, &serial_, &SerialConnection::close);
    connect(&serial_, &SerialConnection::statusChanged, this, [this](const QString& text) { connection_->setText(text); render(); });
    connect(&serial_, &SerialConnection::uartText, this, [this](const QString& text) { guard([&] { engine_.call("serial", {{"text", text}}); }); });
    connect(&serial_, &SerialConnection::uartIdle, this, [this] { guard([&] { engine_.call("serialIdle"); }); });
    connect(&serial_, &SerialConnection::uartReset, this, [this] { guard([&] { engine_.call("serialReset"); }); });
    connect(&serial_, &SerialConnection::slcanLine, this, [this](const QString& text) { guard([&] { engine_.call("slcan", {{"text", text}}); }); });
    connect(&serial_, &SerialConnection::rawText, this, [this](const QString& text) {
        raw_->moveCursor(QTextCursor::End); raw_->insertPlainText(text);
        // Also bound a stream containing no newlines (block limits alone cannot).
        if (raw_->toPlainText().size() > 131072) { const auto tail = raw_->toPlainText().right(65536); raw_->setPlainText(tail); }
    });
    connect(qApp, &QApplication::applicationStateChanged, this, [this](Qt::ApplicationState s) { if (s != Qt::ApplicationActive) releaseKeys(); });
    qApp->installEventFilter(this);
    refreshPorts();
    elapsed_.start(); timer_.setInterval(20);
    connect(&timer_, &QTimer::timeout, this, [this] {
        guard([&] { engine_.call("tick", {{"seconds", elapsed_.restart() / 1000.0}}); });
        static int draws = 0;
        if (++draws % 5 == 0) render();
    });
    timer_.start(); render();
}

void Window::guard(const std::function<void()>& operation) {
    try { operation(); } catch (const std::exception& e) { error_ = QString::fromUtf8(e.what()); message_->setText(error_); }
}

QJsonObject Window::execute(const QString& command, const QJsonObject& args) {
    QJsonObject result;
    error_.clear();
    guard([&] { result = engine_.call(command, args); render(); });
    return result;
}

QJsonObject Window::state() { return engine_.call("snapshot"); }

void Window::render() {
    guard([&] {
        const auto s = engine_.call("snapshot", {{"filter", filter_->text()}, {"direction", direction_->currentIndex() == 1 ? "tx" : direction_->currentIndex() == 2 ? "rx" : "all"}});
        const auto v = s["vehicle"].toObject(); const auto u = s["unit"].toObject();
        rpm_->setText(QString::number(qRound(v["rpm"].toDouble()))); speed_->setText(QString::number(v["speedKph"].toDouble(), 'f', 1));
        gear_->setText(v["gear"].toInt() == 0 ? "N" : QString::number(v["gear"].toInt())); coolant_->setText(QString::number(qRound(v["coolantC"].toDouble())));
        rpmBar_->setRange(0, s["redline"].toInt()); rpmBar_->setValue(qRound(v["rpm"].toDouble()));
        ignition_->setText(v["engineOn"].toBool() ? "Vypnout motor [I]" : "Nastartovat [I]");
        pause_->setText(s["paused"].toBool() ? "Pokračovat" : "Pozastavit");
        capture_->setText(s["capturePaused"].toBool() ? "Obnovit záznam" : "Pozastavit záznam");
        message_->setText(error_.isEmpty() ? s["message"].toString() : error_);
        unit_->setText(QString("FET1: %1   FET2: %2   Poslední stupeň: %3   RPM vstup: %4\nProdleva: %5 ms   Odjištění: %6   %7")
            .arg(u["fet1"].toBool() ? "ZAPNUTO" : "vypnuto", u["fet2"].toBool() ? "ZAPNUTO" : "vypnuto")
            .arg(u["lastValidGear"].toInt()).arg(qRound(u["rpm"].toDouble())).arg(static_cast<int>(std::ceil(u["cooldownMs"].toDouble())))
            .arg(u["shiftingFlag"].toInt() == 0 ? "Připraveno" : QString("uvolnění %1").arg(u["shiftingFlag"].toInt() - 1))
            .arg(s["mode"].toString() == "firmware-parser" ? "Původní parser: RPM pouze byte, požadavek 0x642." : "Letos: ECU 0x600, stupeň 0x604, volant 0x666/byte6."));
        for (auto it = pedals_.cbegin(); it != pedals_.cend(); ++it) {
            const QSignalBlocker block(it.value()); it.value()->setValue(qRound(s["pedals"].toObject()[it.key()].toDouble() * 100));
            pedalValues_[it.key()]->setText(QString::number(it.value()->value()) + " %");
        }
        { const QSignalBlocker block(between_); between_->setChecked(s["between"].toBool()); }
        { const QSignalBlocker block(mode_); mode_->setCurrentIndex(s["mode"].toString() == "reference" ? 0 : 1); }
        const auto profile = s["profile"].toObject(); profile_->setText(profile["name"].toString() + QString(" · %1 kbit/s\n").arg(profile["bitrate"].toInt() / 1000) + profile["description"].toString());
        count_->setText(QString("Přijato / generováno: %1 · uchováno: %2 / 5000 · %3").arg(s["count"].toInt()).arg(s["retained"].toInt()).arg(s["capturePaused"].toBool() ? "Záznam pozastaven" : "Záznam aktivní"));
        const auto rows = s["rows"].toArray(); log_->setUpdatesEnabled(false); log_->setRowCount(static_cast<int>(rows.size()));
        for (int i = 0; i < rows.size(); ++i) {
            const auto f = rows[i].toObject(); const auto source = f["source"].toString();
            QStringList bytes; for (const auto b : f["data"].toArray()) bytes << hex(static_cast<quint32>(b.toInt()), 2);
            QStringList decodedValues; const auto decoded = f["decoded"].toObject();
            for (auto it = decoded.begin(); it != decoded.end(); ++it) decodedValues << it.key() + ": " + it.value().toVariant().toString();
            const double milliseconds = f["timestamp"].toDouble() * 1000;
            const bool validTime = f["timestampOrigin"].toString() != "unknown" && std::isfinite(milliseconds) && milliseconds >= 0 && milliseconds <= 8.64e15;
            const auto time = validTime ? QDateTime::fromMSecsSinceEpoch(static_cast<qint64>(milliseconds), QTimeZone::UTC).toString("HH:mm:ss.zzz") : QString("—");
            const QStringList cells{time, (source == "sim" ? "SIM TX / " : source == "uart" ? "UART RX* / " : source == "import" ? "SOUBOR / " : "CAN RX / ") + f["interfaceName"].toString(),
                "0x" + hex(static_cast<quint32>(f["id"].toInt()), f["extended"].toBool() ? 8 : 3), QString::number(bytes.size()) + (f["dlcInferred"].toBool() ? "*" : ""), bytes.join(' '), decodedValues.join(" · ")};
            for (int c = 0; c < cells.size(); ++c) {
                auto* cell = log_->item(i, c);
                if (!cell) { cell = new QTableWidgetItem; log_->setItem(i, c, cell); }
                cell->setText(cells[c]);
            }
        }
        log_->setUpdatesEnabled(true);
        chart_->history = s["history"].toArray(); chart_->redline = s["redline"].toDouble(); chart_->now = v["elapsed"].toDouble(); chart_->update();
        const bool open = serial_.isOpen(); connect_->setEnabled(!open && ports_->count() > 0); disconnect_->setEnabled(open);
        ports_->setEnabled(!open); transport_->setEnabled(!open); refresh_->setEnabled(!open);
    });
}

void Window::refreshPorts() {
    const auto previous = ports_->currentData().toString(); ports_->clear();
    for (const auto& port : QSerialPortInfo::availablePorts()) {
        QString label = port.portName() + " · " + port.description();
        if (port.hasVendorIdentifier()) label += " · VID " + hex(port.vendorIdentifier(), 4);
        if (port.hasProductIdentifier()) label += " PID " + hex(port.productIdentifier(), 4);
        ports_->addItem(label, port.systemLocation());
    }
    const auto index = ports_->findData(previous); if (index >= 0) ports_->setCurrentIndex(index);
    connect_->setEnabled(ports_->count() > 0 && !serial_.isOpen());
}

void Window::importFile(const QString& kind) {
    if (kind == "profile" && serial_.isOpen()) { error_ = "Před změnou profilu odpojte port."; render(); return; }
    const auto path = QFileDialog::getOpenFileName(this, "Načíst " + kind, {}, kind == "profile" ? "JSON (*.json)" : "Záznam (*.log *.txt);;Všechny soubory (*)");
    if (path.isEmpty()) return;
    error_.clear();
    guard([&] {
        QFile f(path);
        if (!f.open(QIODevice::ReadOnly)) throw std::runtime_error(f.errorString().toStdString());
        if (f.size() > (kind == "profile" ? 128 * 1024 : 5 * 1024 * 1024)) throw std::runtime_error("Soubor je příliš velký.");
        const auto bytes = f.readAll();
        if (kind == "profile") {
            QJsonParseError error; const auto doc = QJsonDocument::fromJson(bytes, &error);
            if (error.error != QJsonParseError::NoError || !doc.isObject()) throw std::runtime_error("Neplatný JSON objekt.");
            engine_.call(kind, doc.object());
        } else engine_.call(kind, {{"text", QString::fromUtf8(bytes)}});
        render();
    });
}

void Window::exportFile(const QString& kind, const QString& filename) {
    const auto path = QFileDialog::getSaveFileName(this, "Uložit", filename);
    if (path.isEmpty()) return;
    guard([&] {
        const auto value = engine_.call(kind);
        const auto bytes = kind == "exportLog" ? value["text"].toString().toUtf8() : QJsonDocument(value).toJson(QJsonDocument::Indented);
        QSaveFile f(path);
        if (!f.open(QIODevice::WriteOnly) || f.write(bytes) != bytes.size() || !f.commit()) throw std::runtime_error(f.errorString().toStdString());
    });
}

void Window::editCalibration() {
    error_.clear();
    releaseKeys();
    // Modal editing freezes virtual time while serial monitoring continues.
    const bool running = !state()["paused"].toBool();
    if (running) engine_.call("pause");
    QDialog dialog(this); dialog.setWindowTitle("Model, jednotka a CAN profil — kalibrace JSON"); dialog.resize(850, 650);
    auto* l = new QVBoxLayout(&dialog);
    auto* explanation = new QLabel("Upravte parametry vozidla, šest převodů, časy a limity jednotky i profil.\nPoměry shiftingUnit.ratios[1–6] musí odpovídat vehicle.gearRatios. ratios[0] je pomocný poměr N.\nZměny se použijí najednou po validaci. Skutečný firmware se nemění."); explanation->setWordWrap(true); l->addWidget(explanation);
    auto* editor = new QPlainTextEdit(json(engine_.call("calibration"))); editor->setObjectName("calibrationEditor"); l->addWidget(editor, 1);
    auto* error = new QLabel; error->setTextFormat(Qt::PlainText); error->setWordWrap(true); l->addWidget(error);
    auto* files = new QHBoxLayout;
    auto* load = button("Načíst JSON…", files); auto* save = button("Export aktuální kalibrace…", files); l->addLayout(files);
    auto* actions = new QDialogButtonBox(QDialogButtonBox::Apply | QDialogButtonBox::Close); l->addWidget(actions);
    connect(actions->button(QDialogButtonBox::Close), &QPushButton::clicked, &dialog, &QDialog::reject);
    connect(save, &QPushButton::clicked, this, [this] { exportFile("calibration", "tul-kalibrace.json"); });
    connect(load, &QPushButton::clicked, &dialog, [&] {
        const auto path = QFileDialog::getOpenFileName(&dialog, "Kalibrace", {}, "JSON (*.json)"); if (path.isEmpty()) return;
        QFile f(path); if (!f.open(QIODevice::ReadOnly) || f.size() > 128 * 1024) { error->setText("Nelze načíst soubor do 128 kB."); return; }
        editor->setPlainText(QString::fromUtf8(f.readAll()));
    });
    connect(actions->button(QDialogButtonBox::Apply), &QPushButton::clicked, &dialog, [&] {
        try {
            if (serial_.isOpen()) throw std::runtime_error("Před změnou kalibrace odpojte port.");
            const auto bytes = editor->toPlainText().toUtf8(); if (bytes.size() > 128 * 1024) throw std::runtime_error("Kalibrace může mít nejvýše 128 kB.");
            QJsonParseError parse; const auto doc = QJsonDocument::fromJson(bytes, &parse);
            if (parse.error != QJsonParseError::NoError || !doc.isObject()) throw std::runtime_error("Neplatný JSON objekt.");
            engine_.call("configure", doc.object()); dialog.accept();
        } catch (const std::exception& e) { error->setText(QString::fromUtf8(e.what())); }
    });
    dialog.exec();
    if (running) engine_.call("pause");
    elapsed_.restart(); render();
}

void Window::releaseKeys() {
    const auto held = held_; held_.clear();
    for (auto it = held.begin(); it != held.end(); ++it) pedals_[it.key() == Qt::Key_Space ? "throttle" : it.key() == Qt::Key_B ? "brake" : "clutch"]->setValue(it.value());
}

bool Window::eventFilter(QObject* target, QEvent* event) {
    if (event->type() == QEvent::KeyRelease) {
        auto* key = static_cast<QKeyEvent*>(event);
        if (held_.contains(key->key())) {
            if (!key->isAutoRepeat()) {
                const auto previous = held_.take(key->key());
                pedals_[key->key() == Qt::Key_Space ? "throttle" : key->key() == Qt::Key_B ? "brake" : "clutch"]->setValue(previous);
            }
            return true;
        }
    }
    if (event->type() != QEvent::KeyPress || QApplication::activeModalWidget()) return QMainWindow::eventFilter(target, event);
    auto* key = static_cast<QKeyEvent*>(event);
    if (key->modifiers() & (Qt::ControlModifier | Qt::AltModifier | Qt::MetaModifier)) return false;
    auto* focus = QApplication::focusWidget();
    if (qobject_cast<QLineEdit*>(focus) || qobject_cast<QPlainTextEdit*>(focus) || qobject_cast<QComboBox*>(focus) || qobject_cast<QSlider*>(focus)) return false;
    if (key->key() == Qt::Key_Space && qobject_cast<QPushButton*>(focus)) return false;
    if (key->key() == Qt::Key_Space || key->key() == Qt::Key_B || key->key() == Qt::Key_C) {
        auto* pedal = pedals_[key->key() == Qt::Key_Space ? "throttle" : key->key() == Qt::Key_B ? "brake" : "clutch"];
        if (!held_.contains(key->key())) held_[key->key()] = pedal->value();
        pedal->setValue(100); return true;
    }
    if (!key->isAutoRepeat()) {
        if (key->key() == Qt::Key_I) { execute("ignition"); return true; }
        if (key->key() == Qt::Key_E || key->key() == Qt::Key_Q || key->key() == Qt::Key_N) {
            execute("request", {{"command", key->key() == Qt::Key_E ? "up" : key->key() == Qt::Key_Q ? "down" : "neutral"}}); return true;
        }
    }
    return QMainWindow::eventFilter(target, event);
}

void Window::closeEvent(QCloseEvent* event) {
    timer_.stop(); releaseKeys(); serial_.close(); qApp->removeEventFilter(this); event->accept();
}
