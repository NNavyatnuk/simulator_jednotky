#ifndef SHIFTING
#define SHIFTING

#include <Arduino.h>
#include <twai.h>

const gpio_num_t fet_1_pin  = GPIO_NUM_7;
const gpio_num_t fet_2_pin  = GPIO_NUM_8;

const int actuation_time = 100;
const int neutral_actuation_time = 50;

const double rpm_upper_limit = 14000;
const double rpm_lower_limit = 4000;
const double rpm_neutral_limit = 6000;

const double Ratios[] = {(500.0 * 39.0 / 14.0) / rpm_lower_limit, 39.0/14.0, 39.0/19.0, 37.0/22.0, 29.0/20.0, 30.0/23.0, 26.0/22.0};     // N, 1-6. N sets minimum RPM to shift out of neutral, set = minimumRPM * 1stGearRatio / rpm_lower_limit

extern QueueHandle_t msgQueue;
extern int currentGear;
extern int lastValidGear;
extern int rpm;
extern bool fet_1_state;
extern bool fet_2_state;

void shiftingSetup();
void shiftingHandler(void *parameter);
void shiftGears(twai_message_t * gearRequest);
void pistonUp(void);
void pistonDown(void);
void toNeutral(void);

#endif