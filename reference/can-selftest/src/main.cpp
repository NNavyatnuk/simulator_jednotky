// TUL Racing Shifting Unit: isolated CAN/TWAI self-test.
// Hardware required: Shifting Unit PCB + USB cable only.
// IMPORTANT: Disconnect CAN bus, car wiring, pneumatic valves and all other loads.
// This is NOT the production shifting firmware; it NEVER activates SW1/SW2.

#include <Arduino.h>
#include "driver/twai.h"
#include "esp_err.h"

static constexpr gpio_num_t CAN_TX = GPIO_NUM_26;
static constexpr gpio_num_t CAN_RX = GPIO_NUM_25;
static constexpr int FET1 = 7;
static constexpr int FET2 = 8;
static bool canReady = false;

// These are bench-test identifiers (NOT the vehicle's command identifiers).
static bool roundTrip(const char *name, uint32_t id, uint8_t index, uint8_t value) {
  twai_message_t outgoing = {};
  outgoing.identifier = id;
  outgoing.extd = 0;       // Standard 11-bit CAN frame
  outgoing.rtr = 0;        // Data frame
  outgoing.self = 1;       // Also receive own transmitted frame
  outgoing.data_length_code = 8;
  outgoing.data[index] = value;

  Serial.printf("\nTX %-14s ID=0x%03lX data[%u]=0x%02X\n",
                name, (unsigned long)id, index, value);

  esp_err_t result = twai_transmit(&outgoing, pdMS_TO_TICKS(1000));
  if (result != ESP_OK) {
    Serial.printf("FAIL: transmission request failed (%s)\n", esp_err_to_name(result));
    return false;
  }

  twai_message_t incoming = {};
  result = twai_receive(&incoming, pdMS_TO_TICKS(1500));
  if (result != ESP_OK) {
    Serial.printf("FAIL: no self-received frame (%s)\n", esp_err_to_name(result));
    return false;
  }

  Serial.printf("RX ID=0x%03lX DLC=%u bytes:",
                (unsigned long)incoming.identifier, incoming.data_length_code);
  for (uint8_t i = 0; i < incoming.data_length_code && i < 8; ++i) {
    Serial.printf(" %02X", incoming.data[i]);
  }
  Serial.println();

  bool matches = !incoming.extd && !incoming.rtr &&
                 incoming.identifier == outgoing.identifier &&
                 incoming.data_length_code == outgoing.data_length_code;
  for (int i = 0; i < 8; ++i) {
    if (incoming.data[i] != outgoing.data[i]) matches = false;
  }
  Serial.println(matches ? "PASS: data matches" : "FAIL: received data mismatch");
  return matches;
}

static void runSelfTest() {
  if (!canReady) {
    Serial.println("CAN not initialized; check earlier error.");
    return;
  }
  Serial.println("\n=== Isolated TWAI self-test; no actuators ===");
  int pass = 0;
  pass += roundTrip("UP byte",      0x321, 4, 2);
  pass += roundTrip("DOWN byte",    0x322, 4, 1);
  pass += roundTrip("NEUTRAL byte", 0x323, 4, 0x40);
  pass += roundTrip("GEAR byte",    0x324, 0, 3);
  Serial.printf("\nResult: %d / 4 frames passed\n", pass);
  Serial.println("Tests TWAI round-trip only; NOT production shifting logic or pneumatic actuation.");
}

void setup() {
  // Explicitly command both MOSFET control pins OFF. No HIGH write anywhere.
  digitalWrite(FET1, LOW);
  digitalWrite(FET2, LOW);
  pinMode(FET1, OUTPUT);
  pinMode(FET2, OUTPUT);

  Serial.begin(115200);
  delay(1200); // Allow serial monitor connection
  Serial.println("\nTUL Racing Shifting Unit -- ISOLATED diagnostic firmware");
  Serial.println("Never connect to vehicle CAN or solenoids while running this test.");
  Serial.println("MOSFET control pins GPIO7/GPIO8 held LOW.");

  twai_general_config_t general = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX, CAN_RX, TWAI_MODE_NO_ACK);
  twai_timing_config_t timing = TWAI_TIMING_CONFIG_1MBITS();
  twai_filter_config_t filter = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  esp_err_t err = twai_driver_install(&general, &timing, &filter);
  if (err != ESP_OK) {
    Serial.printf("FAIL: twai_driver_install: %s\n", esp_err_to_name(err));
    return;
  }
  Serial.println("TWAI driver installed");

  err = twai_start();
  if (err != ESP_OK) {
    Serial.printf("FAIL: twai_start: %s\n", esp_err_to_name(err));
    return;
  }
  canReady = true;
  Serial.println("TWAI started, NO_ACK + SELF reception, 1 Mbps");
  runSelfTest();
  Serial.println("\nType 't' in Serial Monitor to repeat the test.");
}

void loop() {
  if (Serial.available()) {
    char c = (char) Serial.read();
    if (c == 't' || c == 'T') runSelfTest();
  }
  delay(10);
}
