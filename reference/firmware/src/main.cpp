#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "twai.h"
#include "shifting.h"
#include "soc/timer_group_struct.h"
#include "soc/timer_group_reg.h"
#include "driver/gpio.h"
#include "driver/twai.h"
#include <stdio.h>

#define DEBUG

TaskHandle_t twaiTask;
TaskHandle_t shiftTask;

// Queue init
const size_t msg_queue_size = 1000; 
QueueHandle_t msgQueue =  xQueueCreate(msg_queue_size, sizeof(twai_message_t));

// Current gear store
int currentGear = 0;
int lastValidGear = 0;
int rpm = 0;
bool fet_1_state = LOW;
bool fet_2_state = LOW;

void setup() {
  Serial.begin(115200);

  twaiSetup();
  delay(50);

  shiftingSetup();
  delay(50);
  
  // Run TwaiHandler on core 1
  xTaskCreatePinnedToCore(
    twaiHandler,      /* Function to implement the task */
    "TwaiHandler",    /* Name of the task */
    10000,            /* Stack size in words */
    NULL,             /* Task input parameter */
    0,                /* Priority of the task */
    &twaiTask,        /* Task handle. */
    1);               /* Core where the task should run */
  
  delay(50);

  // Run ShiftingHandler on core 0
  xTaskCreatePinnedToCore(
    shiftingHandler,    /* Function to implement the task */
    "ShiftingHandler",  /* Name of the task */
    20000,              /* Stack size in words */
    NULL,               /* Task input parameter */
    0,                  /* Priority of the task */
    &shiftTask,         /* Task handle. */
    0);                 /* Core where the task should run */
  
  delay(50);
}

void loop() {
  //Delete arduino framework main task (loop)
  vTaskDelete(NULL);
}