#pragma once
#include <cstdint>

namespace MosfetUsbTelemetry {
// Call once from setup(), after Serial.begin(115200) and the application's
// existing output-pin initialization. This function never configures a pin.
// Supports the classic ESP32 GPIO output register, pins 0..31 only.
bool begin(uint8_t fet1Pin, uint8_t fet2Pin);
}
