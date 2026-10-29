#include "Arduino.h"
#include "shifting.h"
#include "twai.h"

/* =================== REQUIREMENTS ===================
    gearRequest - chodi zprava o zmacknuti padel volantu
        data[4] = 0 je neradit
        data[4] = 1 je podradit
        data[4] = 2 je nad(?)radit
        data[4] = 0x40 je neutral
    gearCurrent - chodi stav senzoru zarazeneho stupne
        data[0] = 0 je N
        data[0] = 1...6 je rychlostni stupen
        data[0] = 7 je mezi stupnemi
    RPM         - chodi aktualni otacky motoru
        FORMA DLE ECU
*/

void shiftingSetup()
{
    pinMode(fet_1_pin, OUTPUT);
    pinMode(fet_2_pin, OUTPUT);
}

void shiftingHandler(void *parameter) {
    uint32_t gearRequestID = 0x642;                     // Identifier of gear change request message
    uint32_t gearCurrentID = 0x604;                     // Identifier of current gear announcement message
    uint32_t rpmID = 0x666;                             // Identifier of current RPM announcement message ========= UPRAVIT PODLE FORMULE =========

    uint8_t shiftingFlag = 0;                           // Is there a current gear change request?
    
    unsigned long timeLast = millis();                  // Time of last gear change
    unsigned long minimumDelay = 300;                   // Minimum delay between gear shifting commands. Should be set experimentally, but at least as long as longest gear shift

    #ifdef DEBUG
    char *toSend;
    #endif

    for(;;) {
        if( uxQueueMessagesWaiting(msgQueue) > 0) {     // Is there a message in the queue?
            twai_message_t Msg;

            #ifdef DEBUG
            Serial.println("Analysing message");
            #endif

            if(xQueueReceive(msgQueue, &(Msg), (TickType_t) 0) == pdPASS) { // Read message from queue
                if (Msg.identifier == rpmID) {                  // Is the message about the RPM?
                    rpm = Msg.data[0];                              // ======== UPRAVIT PODLE FORMULE =========
                } else if (Msg.identifier == gearCurrentID) {   // Is the message about the current gear?
                    currentGear = Msg.data[0];                      // Updates current gear
                    if (Msg.data[0] != 7) {                         // Is the gear locked?
                        lastValidGear = Msg.data[0];                    // Updates last known gear
                    }

                    #ifdef DEBUG
                    Serial.print("Current Gear: ");
                    asprintf(&toSend, "data = %d\n", currentGear);
                    Serial.print((String) toSend);
                    #endif

                } else if (Msg.identifier == gearRequestID) {   // Is the message about shifting?
                    if (Msg.data[4] != 0) {                         // Is it asking for a gear change?
                        if (shiftingFlag == 0) {                        // Is shifting allowed?
                            if (millis() - minimumDelay > timeLast) {       // Has the gear not been changed in the last "minimumDelay" seconds?
                                timeLast = millis();                            // Note last gear change timestamp
                                shiftGears(&Msg);                  // Change gears
                            }
                        }

                        shiftingFlag = 1;                               // Set flag as "recent message requesting gear shift"
                    } else {                                        // Is there no request to change gears?
                        if (shiftingFlag >= 3) {                        // Has there not been a request for x * 50ms?
                            shiftingFlag = 0;                               // Allow next gear shift
                            continue;
                        }
                        
                        if (shiftingFlag != 0) {                        // Is shifting still not allowed?
                            shiftingFlag++;                                 // Increment shifting flag
                        }
                    }
                }
            }
        }
    }
}

void shiftGears (twai_message_t * msg) {
    #ifdef DEBUG
    char *toSend;
    Serial.print("Shifting gears ");
    asprintf(&toSend, "data = %d\n", msg -> data[4]);
    Serial.print((String) toSend);
    #endif

    if (msg -> data[4] == 0x40) {                                                       // Shifting to neutral
        if (rpm < rpm_neutral_limit) {                                                      // Check that engine isn't reving hard
            if (lastValidGear == 1 || lastValidGear == 2) {                                     // Only allow from 1st or 2nd gear
                toNeutral();
            } else {
                Serial.println("WARNING: Attempted shifting to neutral from wrong gear!");
            }
        } else {
            Serial.println("WARNING: Attempted shifting to neutral at high RPM!");
        }
    } else if (msg -> data[0] == 2) {                                                   // Shifting up
        if (rpm * Ratios[lastValidGear + 1] / Ratios[lastValidGear] > rpm_lower_limit) {    // Check that engine won't be under-reved
            if (lastValidGear == 0) {                                                           // Shifting up from neutral is in a different piston direction
                pistonUp();
            } else {
                pistonDown();
            }
        } else {
            Serial.println("WARNING: Attempted under-reving!");
        }
    } else if (msg -> data[0] == 1) {                                                   // Shifting down
        if (rpm * Ratios[lastValidGear - 1] / Ratios[lastValidGear] < rpm_upper_limit) {    // Check that engine won't be over-reved
            if (lastValidGear > 1) {                                                            // Only allow shifting down to 1st speed
                pistonUp();
            } else {
                Serial.println("WARNING: Attempted shifting down from 1st or lower gear!");
            }
        } else {
            Serial.println("WARNING: Attempted over-reving!");
        }
    }
}

void pistonUp (void) {
    #ifdef DEBUG
    Serial.println("Piston moving up");
    #endif

    if ((fet_1_state == LOW) && (fet_2_state == LOW)) {
        fet_1_state = HIGH;
        digitalWrite(fet_1_pin, fet_1_state);
        delay(actuation_time);
        fet_1_state = LOW;
        digitalWrite(fet_1_pin, fet_1_state);
    } else {
        Serial.println("WARNING: Shifting conflict!");
    }
}

void pistonDown (void) {
    #ifdef DEBUG
    Serial.println("Piston moving down");
    #endif

    if ((fet_1_state == LOW) && (fet_2_state == LOW)) {
        fet_2_state = HIGH;
        digitalWrite(fet_2_pin, fet_2_state);
        delay(actuation_time);
        fet_2_state = LOW;
        digitalWrite(fet_2_pin, fet_2_state);
    } else {
        Serial.println("WARNING: Shifting conflict!");
    }
}

void toNeutral (void) {
    #ifdef DEBUG
    Serial.print("to N");
    #endif

    if (currentGear == 1) {
        if ((fet_1_state == LOW) && (fet_2_state == LOW)) {
            fet_2_state = HIGH;
            digitalWrite(fet_2_pin, fet_2_state);
            delay(neutral_actuation_time);
            fet_2_state = LOW;
            digitalWrite(fet_2_pin, fet_2_state);
        } else {
            Serial.println("WARNING: Shifting conflict!");
        }
    } else if (currentGear == 2) {
        if ((fet_1_state == LOW) && (fet_2_state == LOW)) {
            fet_1_state = HIGH;
            digitalWrite(fet_1_pin, fet_1_state);
            delay(neutral_actuation_time);
            fet_1_state = LOW;
            digitalWrite(fet_1_pin, fet_1_state);
        } else {
            Serial.println("WARNING: Shifting conflict!");
        }
    }
}