# TUL Shifting Unit: doložené rozhraní a hranice modelu

Podkladem jsou uživatelem dodaný archiv `shifting-unit-firmware-main.zip`, PDF `Documentation Shifting Unit v1.3 (4).pdf` a nově dodané CAN screenshoty. Aktuální screenshotová mapa je níže oddělená od chování přiložené starší revize firmware; tím se jejich vzájemné rozpory nezamaskují. Úplná DBC, významy jednotlivých příkazů současného volantu a skutečný záznam stisků pádel zatím doloženy nejsou; mapu vozu 2019 nelze samostatně potvrdit.

Původní soubory nebyly změněny. Zkratka **F** níže znamená uchovanou kopii `reference/firmware`; **T** znamená `reference/can-selftest`. Originály pocházejí z `/workspace/attachments/a4a4019e-72d4-484b-bfb7-a8d988944b65/extracted/` ze složek `shifting-unit-firmware-main` a `shifting-unit-can-selftest`. PDF je v `/workspace/attachments/6d5f7a0f-10f5-40bd-98c2-9da17a8be805/Documentation Shifting Unit v1.3 (4).pdf`.

## Aktuální vůz podle nových CAN screenshotů

Tato mapa má přednost pro výchozí simulaci. Je oddělená od níže zachovaného parseru staršího firmware; stejné ID `0x666` má v obou variantách zcela jiný účel. Zdrojem jsou uživatelské screenshoty konfigurace v tomto chatu, nikoli domyšlená oprava starého kódu.

| Aktuální zpráva | Doložený signál | Doložení |
| --- | --- | --- |
| ECU, základ `0x600` | RPM od byte0, unsigned16, little-endian, scale1, offset0 | Screenshot konfigurace ECU. Například 14000 RPM = bajty `B0 36`. |
| Převodovka `0x604` | Stupeň od byte0, unsigned8 | Screenshot mapy převodovky. |
| `SW_switchboard`, `0x666` | `shift` jako raw unsigned8 v byte6, bez škály | Screenshot volantu, včetně osmibajtového příkladu `00 14 DC 01 08 00 08 00`. |
| Stejný byte6 | StandBy: bit5, maska `0x20`; resetFuel: 3 bity od bit2, maska `0x1C` | Další definice v tomtéž screenshotu. |

Screenshot **nepotvrzuje**, jaké hodnoty nebo bity současný volant přiřazuje UP/DOWN/N. Významy DOWN=1, UP=2, N=`0x40` a z nich sestavená maska `0x43` jsou zatím **hypotéza převzatá ze staršího firmware**, nikoli ověřený protokol nového volantu. Bit7 (`0x80`) zůstává neobjasněný. Specializovaný dekodér vrací raw bajt, předpokládané bity příkazů, StandBy, resetFuel a neznámý bit zvlášť; analýza vždy vrací upozornění na tuto hypotézu.

Příklad ze screenshotu obsahuje v byte6 `0x08`: doložená definice resetFuel dává hodnotu **2**. Pod hypotetickou maskou `0x43` nejsou aktivní žádné bity řazení; nesmí se z něj odvozovat skutečný stisk pádla. Totéž platí pro samotné StandBy. Při sestavení simulovaného příkazu `makeTulRequest` mění pouze masku `0x43`, zachovává StandBy/resetFuel, neobjasněný bit7 i ostatní bajty dodaného základního rámce.

`CURRENT_CAR_PROTOCOL` a výchozí `TUL_CAN_PROFILE` používají aktuální ID. `makeTulRpm` nyní může doložené RPM u16LE bezpečně sestavit; nedefinované další bajty jsou modelové nuly nebo převzaté ze zadaného základního rámce. `LEGACY_TUL_PROTOCOL`, `TUL_LEGACY_CAN_PROFILE` a volba `{protocol: 'legacy'}` zachovávají původní byte4/ID0x642 a surové RPM0x666. Výchozí profil má osmibajtové modelové rámce; specializovaný dekodér přijímá data od minima potřebného pro známé signály (request7/RPM2/gear1) do8 bajtů. Osmibajtové nulové doplnění není tvrzení o významu ostatních signálů.

1 Mbit/s je přímo doloženo nastavením přiloženého firmware. Screenshoty poskytují uvedenou mapu signálů; samy nedokládají změnu fyzické rychlosti sběrnice. Pro potvrzení masky a hodnot pádel je potřeba porovnat raw0x666 při UP, DOWN, N, uvolnění a při změně StandBy/resetFuel.

## Protokol ze zdrojového kódu (starší parser)

| Rámec | Doložené čtení | Význam a omezení |
| --- | --- | --- |
| `0x642` | `data[4]`; pro UP/DOWN navíc `data[0]` | Komentář určuje 0=uvolněno, 1=DOWN, 2=UP, `0x40`=N v pátém bajtu. Skutečné větvení UP/DOWN ale čte první bajt. |
| `0x604` | `data[0]` | Komentář: 0=N, 1–6=stupeň, 7=mezi stupni. Kód při 7 ponechá poslední známý stupeň. Jiné hodnoty kód nevaliduje. |
| `0x666` | `data[0]` | Pouze surový unsigned bajt 0–255, bez škály. ID i mapování mají přímo ve zdroji poznámku „UPRAVIT PODLE FORMULE“. Není to potvrzené kódování fyzických otáček. |

Odkazy: `F/src/shifting.cpp:5–16`, `:26–28`, `:48–54`, `:62–79`, `:96–118`.

Minimální délky vyplývající z přístupů jsou 5/1/1 bajtů. **Skutečné provozní DLC není předepsáno ani kontrolováno**; 8 bajtů v self-testu se na produkční rozhraní nepřenáší jako důkaz. `makeTulRequest` a `makeTulGear` vytvářejí minimální simulované rámce a nic fyzicky neposílají. `decodeTulFrame` toleruje správně doplněné délky až 8 bajtů. Generický profil slouží pro popis minimálních délek; při dekódování reálných záznamů je vhodný specializovaný dekodér. Všechny známé signály jsou celé unsigned bajty; vícebajtová škála, bitová pole, CRC ani čítač nejsou ve zdroji definovány.

TWAI je nastaven na **1 Mbit/s**, režim `NORMAL`, filtr `ACCEPT_ALL` (`F/src/twai.cpp:10–12`). Zamýšlený formát je standardní 11bit CAN, avšak produkční příjem rozšířený rámec pouze vypíše jako varování; nezahodí ho. Ani RTR není před předáním do řadicí fronty odmítnuto (`F/src/twai.cpp:44–64`). Simulátor a specializovaný protokol cílí na standardní datové rámce, nikoli na tyto nevalidované vstupy.

## Řadicí logika a výstupy

- GPIO7/FET1 je `pistonUp`, GPIO8/FET2 `pistonDown` (`F/include/shifting.h:7–8`; `F/src/shifting.cpp:129–155`). Normální pulz má 100 ms, neutrální 50 ms (`F/include/shifting.h:10–11`). Směry pístu nelze zaměňovat se směrem řazení.
- UP: predikované otáčky po přeřazení musí být **větší než 4000**. Z N se aktivuje FET1; z jiného stupně FET2. DOWN: predikce musí být **menší než 14000** a poslední platný stupeň musí být vyšší než 1 (`F/src/shifting.cpp:106–125`).
- N: pouze z posledního známého 1 nebo 2 a při otáčkách **nižších než 6000**; výstup závisí na aktuálním senzoru: z 1 FET2, z 2 FET1 (`F/src/shifting.cpp:96–105`, `:161–185`). Běžné DOWN z 1 automaticky N nevolí.
- Převody N,1–6: `(500×39/14)/4000`, `39/14`, `39/19`, `37/22`, `29/20`, `30/23`, `26/22`. N je pomocná konstanta pro podmínku řazení, nikoli fyzický převod (`F/include/shifting.h:13–17`).
- Mezi pokusy se používá 300ms brána; čas se zapíše ještě před kontrolou otáček. Každý nenulový požadavek nastaví blokaci, i když byl odmítnut. K opětovnému povolení jsou nutné **tři nulové zprávy**, nikoli prokázaných 150 ms; komentář pouze předpokládá 50ms periodu (`F/src/shifting.cpp:63–79`).
- Žádný CAN heartbeat, stavový TX, automatický retry, úspěch potvrzený časovým limitem, stáří RPM/senzoru ani CAN reset příkaz v přiloženém firmware implementován není. Řadicí jednotka sama CAN rámce nevysílá. Stupeň mění až externí senzorová zpráva. Při selhání startu TWAI se volá `ESP.restart()` (`F/src/twai.cpp:23–28`).

## Zjištěné vady a nevyřešené definice

1. **Rozpor bajtů UP/DOWN:** brána a komentář používají `data[4]`, větvení skutečného kódu `data[0]`. Simulátor tento rozpor ukazuje; nevyplňuje skrytě první bajt, aby ho zamaskoval.
2. **RPM TODO:** z jediného unsigned bajtu nelze bez mapování získat otáčky požadované kontrolou 4000/14000. Doslovné `rpm = data[0]` nemůže povolit žádný standardní UP, ani z N, kde je potřeba více než 500 ot/min. Fyzický RPM encoder pro tento starší parser proto není implementován; aktuální screenshotová mapa0x600 se používá odděleně.
3. **Indexy převodů:** UP z 6 čte `Ratios[7]`; DOWN z N čte `Ratios[-1]` ještě před podmínkou stupně. C++ chování je nedefinované, nelze ho věrně numericky simulovat (`F/src/shifting.cpp:106–118`). Chybí také validace přijatého stupně a DLC.
4. **Časová aritmetika:** výraz `millis() - minimumDelay > timeLast` používá unsigned odečítání, které během prvních 300 ms podteče. Není ekvivalentní robustnímu měření času od posledního pokusu (`F/src/shifting.cpp:65`).
5. **Chybějící vozidlové parametry:** nejsou doloženy hmotnost bolidu, finální převod, pneumatika, momentová mapa ani skutečné CAN časování/perioda volantu. Aktuální ECU RPM signál již dokládá screenshot výše. Zbývající dynamika vozidla je výslovně model, ne ověřené chování formule.

## Diagnostický self-test není další vozidlový protokol

`T/src/main.cpp:16–24` nastavuje standardní datový rámec, self-reception a DLC 8. V `:66–69` používá testovací ID `0x321`/UP, `0x322`/DOWN, `0x323`/N a `0x324`/stupeň; ostatní bajty jsou nulové. Režim je `NO_ACK`, 1 Mbit/s, accept-all (`:87–89`). GPIO7/8 jsou drženy LOW (`:74–79`). Test se spustí po startu a znakem `t` nebo `T` (`:105–112`). Nevolá produkční řadicí logiku a výsledek 4/4 neprokazuje komunikaci s externím volantem ani pneumatiku (`T/README_UA.md:13–14`, `:24–27`). Tato ID se nesmějí prezentovat jako skutečná ID vozu.

## Co potvrzuje PDF

PDF str. 1 popisuje jednotku pro pneumatické řazení formule Klárka. Str. 5 uvádí MCU ESP32-PICO-V3, CAN transceiver SN65HVD230DR s podporou 1 Mbit/s a **CP2102 jako USB–UART programátor**. Schéma na str. 7 spojuje CAN RX/TX s GPIO25/26 a výstupy FET1/FET2 s GPIO7/8. PDF nepotvrzuje CAN ID, DLC, mapování RPM ani variantu 2019/nový vůz.

Připojení USB kabelu k CP2102 proto samo nedělá z jednotky SLCAN adaptér. Produkční firmware tiskne lidsky čitelný diagnostický text při 115200 baud (`F/src/main.cpp:29`; `F/src/twai.cpp:38–58`), nikoli SLCAN ASCII rámce. Existující Web Serial SLCAN monitor potřebuje skutečný kompatibilní USB–CAN adaptér; neumí přímo parsovat tento firmware nebo ovládat jeho solenoidy.
