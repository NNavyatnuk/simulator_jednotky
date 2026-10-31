#include "engine.h"
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <stdexcept>

static void resources() { Q_INIT_RESOURCE(resources); }
namespace {
[[noreturn]] void fail(const QString& text) { throw std::runtime_error(text.toStdString()); }
}

int Engine::interrupt(JSRuntime*, void* opaque) {
    return std::chrono::steady_clock::now() > static_cast<Engine*>(opaque)->deadline_;
}

JSModuleDef* Engine::load(JSContext* context, const char* name, void*) {
    const auto path = QDir::cleanPath(QString::fromUtf8(name));
    static const QStringList allowed = { "src/simulator.js", "src/shifting-unit.js", "src/tul-protocol.js", "src/tul-serial.js", "src/can.js" };
    if (!allowed.contains(path)) {
        JS_ThrowReferenceError(context, "Module not bundled: %s", name);
        return nullptr;
    }
    QFile file(":/" + path);
    if (!file.open(QIODevice::ReadOnly)) {
        JS_ThrowReferenceError(context, "Cannot read bundled module: %s", name);
        return nullptr;
    }
    const auto source = file.readAll();
    auto value = JS_Eval(context, source.constData(), static_cast<size_t>(source.size()), name,
                         JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(value)) return nullptr;
    auto* module = static_cast<JSModuleDef*>(JS_VALUE_GET_PTR(value));
    JS_FreeValue(context, value);
    return module;
}

QString Engine::exception() {
    auto error = JS_GetException(context_);
    const char* text = JS_ToCString(context_, error);
    QString result = text ? QString::fromUtf8(text) : QStringLiteral("JavaScript exception");
    JS_FreeCString(context_, text);
    auto stack = JS_GetPropertyStr(context_, error, "stack");
    if (!JS_IsUndefined(stack)) {
        text = JS_ToCString(context_, stack);
        if (text) result += '\n' + QString::fromUtf8(text);
        JS_FreeCString(context_, text);
    }
    JS_FreeValue(context_, stack);
    JS_FreeValue(context_, error);
    return result;
}

Engine::Engine() {
    resources();
    runtime_ = JS_NewRuntime();
    if (!runtime_) fail("Cannot allocate JavaScript runtime");
    JS_SetMemoryLimit(runtime_, 128 * 1024 * 1024);
    JS_SetMaxStackSize(runtime_, 512 * 1024);
    JS_SetModuleLoaderFunc(runtime_, nullptr, load, nullptr);
    JS_SetInterruptHandler(runtime_, interrupt, this);
    context_ = JS_NewContext(runtime_);
    if (!context_) { JS_FreeRuntime(runtime_); runtime_ = nullptr; fail("Cannot allocate JavaScript context"); }
    try {
        QFile file(":/desktop/controller.js");
        if (!file.open(QIODevice::ReadOnly)) fail("Missing bundled desktop controller");
        const auto source = file.readAll();
        deadline_ = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        auto value = JS_Eval(context_, source.constData(), static_cast<size_t>(source.size()), "desktop/controller.js", JS_EVAL_TYPE_MODULE);
        const bool error = JS_IsException(value);
        JS_FreeValue(context_, value);
        if (error) fail(exception());
    } catch (...) {
        JS_FreeContext(context_); JS_FreeRuntime(runtime_);
        context_ = nullptr; runtime_ = nullptr;
        throw;
    }
}

Engine::~Engine() {
    if (context_) JS_FreeContext(context_);
    if (runtime_) JS_FreeRuntime(runtime_);
}

QJsonObject Engine::call(const QString& command, const QJsonObject& args) {
    const auto name = command.toUtf8();
    const auto json = QJsonDocument(args).toJson(QJsonDocument::Compact);
    auto global = JS_GetGlobalObject(context_);
    auto fn = JS_GetPropertyStr(context_, global, "desktopDispatch");
    JSValue argv[] = { JS_NewStringLen(context_, name.constData(), static_cast<size_t>(name.size())),
                       JS_NewStringLen(context_, json.constData(), static_cast<size_t>(json.size())) };
    deadline_ = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    auto result = JS_Call(context_, fn, global, 2, argv);
    for (auto value : argv) JS_FreeValue(context_, value);
    JS_FreeValue(context_, fn); JS_FreeValue(context_, global);
    if (JS_IsException(result)) { JS_FreeValue(context_, result); fail(exception()); }
    const char* text = JS_ToCString(context_, result);
    const auto document = text ? QJsonDocument::fromJson(QByteArray(text)) : QJsonDocument();
    JS_FreeCString(context_, text); JS_FreeValue(context_, result);
    if (!document.isObject()) fail("Invalid desktop controller response");
    return document.object();
}
