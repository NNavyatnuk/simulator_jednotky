#ifndef TWAI_H
#define TWAI_H

#include <Arduino.h>
#include "driver/gpio.h"
#include "driver/twai.h"
#include <stdio.h>

const gpio_num_t twai_tx_pin  = GPIO_NUM_26;
const gpio_num_t twai_rx_pin  = GPIO_NUM_25;

extern QueueHandle_t msgQueue;

void twaiSetup();
void twaiHandler(void *parameter);

#endif
