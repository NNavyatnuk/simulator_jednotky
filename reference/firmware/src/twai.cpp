#include "twai.h"
#include "driver/gpio.h"
#include "driver/twai.h"
#include <stdio.h>

#define DEBUG

void twaiSetup() {  
  //Initialize configuration structures using macro initializers
  twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(twai_tx_pin, twai_rx_pin, TWAI_MODE_NORMAL);
  twai_timing_config_t t_config = TWAI_TIMING_CONFIG_1MBITS();
  twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  // Install TWAI driver
  if (twai_driver_install(&g_config, &t_config, &f_config) == ESP_OK) {
    Serial.print("Driver installed\n");
  } else {
    Serial.print("Failed to install driver\n");
    return;
  }

  // Start TWAI driver
  if (twai_start() == ESP_OK) {
    Serial.print("Driver started\n");
  } else {
    Serial.print("Failed to start driver\n");
    ESP.restart();
  }
}

void twaiHandler(void *parameter) {
  char * toSerial;          // Stores string to be printed to serial
  twai_message_t twaiMsg;   // Contains received message

  for(;;) {
    // Wait for message to be received
    if (twai_receive(&twaiMsg, pdMS_TO_TICKS(10000)) == ESP_OK) {
      Serial.print("Message received\n");
    } else {
      Serial.print("Failed to receive message\n");
      continue;
    }

    if (twaiMsg.extd) { // Checks that message is in standard format
      Serial.print("Warning: Message received in extended format!\n");
    } else {
      #ifdef DEBUG
      Serial.print("Message is in Standard Format\n");
    }

    // Print contents to serial
    asprintf(&toSerial, "ID is %d\n", twaiMsg.identifier);
    Serial.print((String) toSerial);
    if (!(twaiMsg.rtr)) {
      for (int i = 0; i < twaiMsg.data_length_code; i++) {
        asprintf(&toSerial, "Data byte %d = %d\n", i, twaiMsg.data[i]);
        Serial.print((String) toSerial);
      }
    }
    #endif

    // Send message to queue
    if(xQueueSend( msgQueue, (void *) &twaiMsg, 100*portTICK_PERIOD_MS) != pdPASS) {
      Serial.println("Failed to send Can message to queue");
    }
  }
}