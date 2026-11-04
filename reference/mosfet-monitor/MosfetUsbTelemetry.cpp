#include "MosfetUsbTelemetry.h"
#include "MosfetTelemetryCore.h"

#include <Arduino.h>
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "soc/gpio_reg.h"
#include "soc/soc.h"

#if !defined(CONFIG_IDF_TARGET_ESP32)
#error "This passive output-latch observer supports the classic ESP32 only."
#endif

namespace MosfetUsbTelemetry {
namespace {
QueueHandle_t observations = nullptr;
TaskHandle_t sampler = nullptr;
TaskHandle_t writer = nullptr;
uint8_t firstPin = 0;
uint8_t secondPin = 0;
bool started = false;

void sampleOutputs(void*) {
    Collector collector;
    TickType_t lastWake = xTaskGetTickCount();
    const TickType_t period = pdMS_TO_TICKS(1) > 0 ? pdMS_TO_TICKS(1) : 1;
    for (;;) {
        const auto timeUs = static_cast<uint64_t>(esp_timer_get_time());
        // gpio_get_level() is not suitable for output-only pins whose input
        // buffer is disabled. Read one OUTPUT LATCH snapshot instead; this
        // never enables input buffers or changes the user's pin configuration.
        const uint32_t levels = REG_READ(GPIO_OUT_REG);
        Observation observation{};
        if (collector.sample(timeUs, ((levels >> firstPin) & 1U) != 0,
                             ((levels >> secondPin) & 1U) != 0, observation)) {
            // Never wait for serial or queue space in the sampler. A dropped
            // observation consumes its sequence number and is detectable by
            // the USB monitor when the next observation arrives.
            xQueueSend(observations, &observation, 0);
        }
        vTaskDelayUntil(&lastWake, period);
    }
}

void writeObservations(void*) {
    Observation observation{};
    char line[96];
    for (;;) {
        if (xQueueReceive(observations, &observation, portMAX_DELAY) != pdTRUE) continue;
        const size_t length = format(observation, line, sizeof(line));
        // ESP32 HardwareSerial serializes each write using its UART lock.
        // Emit each complete record in a single write, including its newline.
        if (length) Serial.write(reinterpret_cast<const uint8_t*>(line), length);
    }
}
} // namespace

bool begin(uint8_t fet1Pin, uint8_t fet2Pin) {
    if (started) return firstPin == fet1Pin && secondPin == fet2Pin;
    if (fet1Pin > 31 || fet2Pin > 31 || fet1Pin == fet2Pin) return false;
    firstPin = fet1Pin;
    secondPin = fet2Pin;
    observations = xQueueCreate(64, sizeof(Observation));
    if (!observations) return false;
    if (xTaskCreate(writeObservations, "fet-usb", 4096, nullptr, 1, &writer) != pdPASS) {
        vQueueDelete(observations);
        observations = nullptr;
        return false;
    }
    if (xTaskCreate(sampleOutputs, "fet-sample", 2048, nullptr, 1, &sampler) != pdPASS) {
        vTaskDelete(writer);
        writer = nullptr;
        vQueueDelete(observations);
        observations = nullptr;
        return false;
    }
    started = true;
    return true;
}
} // namespace MosfetUsbTelemetry
