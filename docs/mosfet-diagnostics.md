# Živá diagnostika výstupů FET1/FET2 přes USB

V aplikaci otevřete **MOSFET výstupy** a připojte **USB jednotky · debug UART** na 115200 baud. Příjem je pouze pro čtení. Aplikace neposílá příkaz k sepnutí výstupu, neflashuje jednotku a nevydává simulované FET stavy za skutečnou telemetrii.

Původní dodaný firmware vypisuje pouze přijaté CAN zprávy. Neobsahuje telemetrii výstupů. Bez jejího doplnění panel čeká na data; připojený port a přicházející CAN zprávy samy kontrolu MOSFETů nepotvrzují.

## Doplnění telemetrie do firmware

Volitelný pomocný kód je v [reference/mosfet-monitor](../reference/mosfet-monitor/). Původní důkazní kopie `reference/firmware` zůstává nezměněná. Do svého pracovního projektu Arduino/PlatformIO pro klasické ESP32 zkopírujte:

- `MosfetUsbTelemetry.h` a `MosfetTelemetryCore.h` do `include/`;
- `MosfetUsbTelemetry.cpp` do `src/`.

V `main.cpp` přidejte:

```cpp
#include "MosfetUsbTelemetry.h"
```

V `setup()` po existujícím `Serial.begin(115200)` a `shiftingSetup()` spusťte pozorování již používaných výstupů:

```cpp
if (!MosfetUsbTelemetry::begin(static_cast<uint8_t>(fet_1_pin),
                               static_cast<uint8_t>(fet_2_pin))) {
    Serial.println("MOSFET telemetry could not start");
}
```

Pro dodaný firmware jsou to GPIO7 a GPIO8 podle `shifting.h`. Pomocný kód žádný pin nekonfiguruje a nikdy do něj nezapisuje. Nepřidává CAN vysílání ani USB příkazy. Nahrání upraveného firmware je samostatný úkon uživatele; aplikace ho neprovádí. Tento pomocník nenahrazuje ani neopravuje původní parser řazení.

Pozorovací úloha čte oba bity jedním čtením `GPIO_OUT_REG`. Čte tedy **řídicí výstupní registr GPIO**, nikoli elektrické napětí na pinu či výkonovém vývodu tranzistoru. Nepoužívá `gpio_get_level()`, který na výstupu s vypnutým vstupním bufferem nemusí stav vracet, ani kvůli čtení nepřepíná režim pinů. Pomocník je určen pro klasické ESP32 a piny 0–31; jiné varianty čipu vyžadují vlastní ovladač čtení.

Vzorkování probíhá po 1 ms, případně po jednom ticku FreeRTOS, pokud je delší. Odesílá se změna stavu a heartbeat nejpozději po 50 ms pozorovacího času. Kratší přechody než vzorkovací perioda mohou uniknout. Čas je 64bitový `esp_timer_get_time()` z jednotky, ne čas přijetí na PC. Samostatná odesílací úloha zpracovává omezenou frontu; při jejím přetečení vznikne mezera v pořadových číslech, kterou aplikace vyhodnotí jako neúplná data. Přidané plánování a UART provoz mohou ovlivnit časování firmware. Nejde o bezeztrátový osciloskopický záznam.

Každý řádek se odesílá jedním `Serial.write()`. Před ním je oddělovací nový řádek, aby běžný neukončený debug tisk nespojil telemetrii s jiným textem. Pomocník předpokládá běžné zamykání UART v ESP32 HardwareSerial; nezapínejte konfiguraci, která toto zamykání vypíná, a neobcházejte HardwareSerial souběžnými nízkoúrovňovými zápisy do stejného UART.

## Formát USB záznamu

```text
MOSFET,1,gpio,0,1000000,0,0
MOSFET,1,gpio,1,1050000,0,0
MOSFET,1,gpio,2,1060000,1,0
MOSFET,1,gpio,3,1110000,1,0
MOSFET,1,gpio,4,1160000,0,0
MOSFET,1,gpio,5,1210000,0,0
MOSFET,1,gpio,6,1260000,0,0
MOSFET,1,gpio,7,1310000,0,0
MOSFET,1,gpio,8,1360000,0,0
MOSFET,1,gpio,9,1370000,0,1
MOSFET,1,gpio,10,1420000,0,0
```

Pole jsou `MOSFET,verze,zdroj,pořadí,čas_us,fet1,fet2`. Verze je `1`; pořadí i čas jsou nezáporná celá čísla. Pořadí narůstá o jedna pro každý pokus o odeslání. Čas je monotónní čas v mikrosekundách od startu jednotky. `0` znamená neaktivní, `1` aktivní. Příklad obsahuje celý 100ms impulz FET1 a 50ms impulz FET2. Při nezměněném stavu musí producent pokračovat heartbeat záznamy.

Zdroj `gpio` znamená hlášený stav řídicího GPIO; dodaný pomocník čte výstupní registr. Pro skutečnou zpětnou vazbu napětí/proudu lze použít vlastní měřicí firmware se zdrojem `load`, který publikuje stejný formát s naměřenými, správně polarizovanými stavy. Tato měřicí část a její zapojení nejsou v dodaném hardware ani v tomto pomocníku implementovány. Hodnoty výstupního registru nepřejmenovávejte na `load`.

## Co výsledek znamená

Monitor sleduje délky úplných impulzů, návrat do vypnutého stavu a souběžné sepnutí obou výstupů. Kontroluje pořadí a časové značky. Neúplný impulz při připojení, ztracené záznamy, restart jednotky nebo chybějící telemetrie nemají znamenat úspěšný test. Výsledek pro oba výstupy vyžaduje jejich skutečné pozorované impulzy. Diagnostika má vlastní reset a běží nezávisle na pozastavení simulace nebo CAN záznamu.

Úspěšná kontrola zdroje `gpio` potvrzuje jen pozorované řídicí impulzy. **Nepotvrzuje skutečné sepnutí MOSFETu, proud cívkou, napětí na zátěži ani pohyb ventilu.** K tomu je nutné měření výkonového výstupu. Aplikace neprovádí takové měření prostřednictvím samotného CP2102.

## Ověření pomocného kódu

Přenosné jádro pro pořadová čísla, heartbeat a formát lze otestovat bez desky:

```sh
c++ -std=c++17 -Wall -Wextra -Werror reference/mosfet-monitor/tests/core-test.cpp -o /tmp/mosfet-core-test
/tmp/mosfet-core-test
```

Tento test neověřuje integraci ESP32/Arduino, časování na konkrétní desce ani výkonové výstupy. Kompletní firmware je nutné sestavit a ověřit ve vašem pracovním projektu pro konkrétní jednotku.
