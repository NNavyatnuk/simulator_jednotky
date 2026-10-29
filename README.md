# Formula Lab — simulátor řadicí jednotky TUL Racing

Česká webová aplikace pro modelování řadicí jednotky ESP32, sekvenční převodovky a práce s CAN záznamy. Vychází z přiloženého firmware, hardwarové dokumentace v1.3 a screenshotů konfigurace letošního ECU a volantu. Původní zdrojové soubory jsou beze změn v `reference/`; jejich kontrolní součty jsou v `reference/manifest.json`.

## Spuštění přes C++ soubor v repozitáři

Vstupem aplikace je váš soubor **`src/main.cpp`**. Nativní C++17 program spustí místní HTTP server a zpřístupní ovládací panel z `index.html` a modulů `src/`. Pro tuto cestu nepotřebujete Node.js. Výpočty vozu a řadicí jednotky běží v prohlížeči; nejde o firmware pro nahrání do ESP32.

Máte-li CMake a C++ překladač (Visual Studio, GCC nebo Clang):

```sh
cmake -S . -B build
cmake --build build --config Release
```

Na Windows spusťte `build\\Release\\simulator_jednotky.exe` (Visual Studio), případně `build\\simulator_jednotky.exe` (MinGW/Ninja). Na Linuxu použijte `./build/simulator_jednotky`. Program vypíše adresu místního panelu; zadejte ji v Chrome nebo Edge na stejném počítači. Okno programu ponechte spuštěné; ukončíte jej pomocí Ctrl+C.

Bez CMake stačí GCC / MinGW:

```sh
# Linux
c++ -std=c++17 -O2 src/main.cpp -o simulator_jednotky
./simulator_jednotky
```

```bat
REM Windows s MinGW
g++ -std=c++17 -O2 src/main.cpp -o simulator_jednotky.exe -lws2_32
simulator_jednotky.exe
```

Program se váže pouze na `127.0.0.1`, výchozí port je 3000. `--port 3001` změní port, `--root cesta` určí složku s `index.html` a `src/`; `--help` vypíše nápovědu. Nespouštějte jej jako PlatformIO firmware. Při kopírování aplikace na jiný počítač ponechte spolu program, `index.html` a adresář `src/`.

## Alternativní spuštění přes Node.js

Vyžaduje Node.js 24+ (testovaná verze v `.node-version`).

```sh
npm ci
npm start
```

Server používá port 3000. Volitelné proměnné `PORT` a `HOST` mění adresu naslouchání. `/health` vrací stav aplikace. `npm run dev` restartuje server při změně souborů; změny klienta načtěte obnovením stránky. Aplikace nemá build krok, databázi ani runtime závislosti. Výpočty i záznamy běží v prohlížeči.

## Co je doloženo a co zůstává modelem

| Signál / konstanta | Hodnota | Podklad |
| --- | --- | --- |
| Letošní otáčky | `0x600`, bajty 0–1, unsigned16 little-endian, 1 rpm/LSB | Screenshot ECU |
| Stupeň | `0x604`, bajt 0; 0=N, 1–6 stupně, 7 mezi stupni | Screenshot + firmware |
| Letošní signál shift | `0x666`, unsigned bajt 6 | Screenshot SW_switchboard |
| Sdílené bity bajtu 6 | StandBy bit 5, resetFuel bity 2–4 | Screenshot SW_switchboard |
| CAN bitrate | 1 Mbit/s | Dodaný `twai.cpp` (aktuální síť neověřena měřením) |
| Pulz / neutrál | 100 / 50 ms | Dodaný `shifting.h` |
| Prodleva / odjištění | 300 ms / tři nulové rámce | Dodaný `shifting.cpp` |
| Otáčkové podmínky | nahoru výsledné RPM >4000; dolů <14000; N při RPM <6000 | Dodaný firmware |

**Kódy DOWN=1, UP=2, N=0x40 a maska `0x43` letošního sdíleného bajtu jsou předpoklad ze starého firmware.** Screenshot ukazuje umístění signálu, ale nikoli význam jednotlivých příkazů. Simulátor tyto předpoklady zřetelně uvádí. `0x08` ze screenshotu se za této masky interpretuje jako resetFuel=2, nikoli řazení. Generátor zachovává ostatní bity sdíleného bajtu a ostatní bajty dodané základní zprávy.

Šest převodů vychází z původního `shifting.h`: 39/14, 39/19, 37/22, 29/20, 30/23, 26/22. Hmotnost, moment motoru, stálý převod, volnoběh a limiter jsou demonstrační parametry, nikoli měření letošního vozu. Úpravou modelu lze zadat nové převody; současně se upraví poměry ochranných výpočtů jednotky. Pomocný poměr N se v ovládacích formulářích přepočítává podle původního výrazu pro 500rpm hranici rozjezdu.

Podrobné odkazy na zdrojové řádky, stránky PDF a rozpory firmware jsou v [docs/TUL-unit-evidence.md](docs/TUL-unit-evidence.md).

## Ovládání a logika

1. **Nastartovat** (`I`), počkat na odblokování jednotky (po spuštění 300 ms).
2. Pravým pádlem (`E`) zařadit jedničku, uvolnit spojku na 0 % a přidat plyn.
3. Plyn lze držet mezerníkem, brzdu `B`, spojku `C`. Po puštění klávesy se vrací nastavení posuvníku. Při práci ve formuláři klávesy vůz neovládají; mezerník na zaměřeném tlačítku zachová běžnou funkci tlačítka.
4. `Q` podřazuje; `N` žádá neutrál z 1. nebo 2. stupně pod 6000 rpm. Nízké otáčky mohou zablokovat přeřazení nahoru, vysoké otáčky podřazení. Zamítnutý požadavek také vyžaduje uvolnění pádel a může spotřebovat prodlevu.

Panel ukazuje stav FET1/FET2, vstupní RPM, poslední platný stupeň, prodlevu a odjištění. Volba **Test čidla: mezi stupni (7)** ponechá poslední platný stupeň v paměti. Virtuální mechanika po přijatém pulzu ideálně dokončí změnu stupně; během pulzu vrací čidlo 7. Nejsou modelovány tlak vzduchu, poruchy ventilů, zpoždění čidla ani skutečná odezva pneumatického systému.

Výchozí režim **Letos** používá mapu ze screenshotů a zamýšlené ochrany z firmware. **Původní firmware — diagnostika rozporů** ponechá původní ID `0x642`, dvojici bajtů 4/0 a osmibitové RPM `0x666`. Ukáže proto nekompatibilitu s letošní sběrnicí. Není to binární emulace ESP32/FreeRTOS: nedefinované přístupy mimo pole se diagnostikují; časování front, blokující delay a přetečení unsigned millis se neemulují. Původní firmware ani jeho soubory se aplikací nemění a nic se neflashuje.

Model zahrnuje podélný pohyb, odpor vzduchu, valivý odpor, brzdění, zjednodušenou spojku a pomoc při rozjezdu/volnoběhu. Nepočítá prokluz kol, diferenciál ani zhasnutí podtočením. Parametry jsou platné pro aktuální relaci; **Exportovat kalibraci JSON** uloží model, převody, konstanty jednotky a CAN profil. Import ověří všechny části před použitím a vyžaduje shodu převodů vozu a jednotky. Tato aplikace generuje letošní sběrnici; starší parser se volí diagnostickým režimem.

## CAN monitor

- **SIM TX / sim0**: virtuální ECU, čidlo a volant. Do fyzické sběrnice se neposílají.
- **CAN RX / can0**: rámce z externího SLCAN adaptéru.
- **UART RX* / uart0**: rekonstrukce textového debug výpisu jednotky; DLC je odvozené.
- **SOUBOR + rozhraní**: importovaný záznam. Jméno rozhraní v cizím souboru samo nepotvrzuje původ dat.

Virtuální ECU/čidlo/volant posílají rámce po 50 ms. Tato perioda je předpoklad simulace, nikoli doložená perioda letošního auta. Neznámé bajty ECU se v modelu nulují. Výchozí čidlo má minimální payload 1 bajt; délky ostatních zpráv nejsou důkazem skutečného DLC. Specializovaný dekodér TUL přijme i delší rámce, pokud obsahují požadované signály. Přijetí externích zpráv je monitorování; samo neovládá virtuální ani skutečný pohon.

Uchovává se posledních 5000 rámců, tabulka zobrazuje posledních 200 odpovídajících ID/datovému a směrovému filtru. Časy živých dat jsou UTC okamžiku doručení prohlížeči, ne hardwarové CAN timestampy. **Pozastavit simulaci** zastaví model a virtuální sběrnici; skutečný příjem pokračuje. **Pozastavit záznam** zastaví ukládání živých rámců; ruční import souboru je nezávislý. Reset zachová záznam.

Importuje se kompaktní Classical CAN candump (max. 5 MB):

```text
(1700000000.123456) can0 600#401F000000000000
(1700000001.123456) can0 666#0014DC0108000800
```

První zpráva má 8000 rpm. Druhá obsahuje screenshotový sdílený bajt `0x08`. Importovat lze také uložený původní UART debug výpis s řádky `ID is 1536` / `Data byte 0 = 64`. Jeho původní čas není znám: tabulka ukazuje pomlčku, candump rezervuje čas 0 a JSON zachovává příznak neznámého času.

Export candump zahrnuje všechny uchované rámce bez ohledu na filtr a ponechá rozhraní sim0/can0/uart0. UART rekonstrukce mají hvězdičku a vysvětlující hlavičku; přesná metadata zachovává **JSON export**. U cizích souborů je původ časů závislý na autorovi. Import JSON záznamu, DBC, CAN FD, RTR, J1939 transport a multiplexing nejsou implementovány.

## USB řadicí jednotky a externí adaptér

Na počítači s jednotkou otevřete aplikaci v Chrome/Edge a zvolte **USB jednotky / CAN adaptér → USB jednotky · CP2102 debug výpis**. Web Serial potřebuje HTTPS nebo lokální důvěryhodný kontext a souhlas prohlížeče s přístupem k portu. USB přístup potřebuje klientský počítač, ne cloudový server.

USB režim otevírá CP2102 na 115200 baud a pouze čte výpis dodaného `twai.cpp`. Neposílá UART příkazy a nevyžaduje SLCAN firmware. Původní program nevypisuje DLC, RTR ani přesný čas CAN; rekonstrukce proto není bezeztrátový CAN záznam. Při neúplném či prokládaném textu mohou rámce chybět. Nepřítomnost zpráv sama nepotvrzuje závadu jednotky. V cloudovém prostředí byl ověřen testovací sériový port, nikoli skutečná deska.

Pro přesnější CAN zachycení zvolte samostatný **Externí SLCAN** adaptér. Sériová rychlost je 115200 baud, CAN bitrate z profilu; vyžaduje potvrzené příkazy C, S0–S8 a režim listen-only L. Nepřepíná se do aktivního O a nevysílá CAN data. CP2102 samotné jednotky není SLCAN adaptér. Žádná z těchto funkcí zatím neposílá ovládání do skutečné jednotky nebo ventilů.

## Vlastní profil a testy

Profil JSON lze stáhnout jako šablonu, upravit a nahrát (128 kB). Obecný kodek podporuje celé bajty, signed/unsigned, little/big-endian, scale a offset, kontrolu rozsahů a DLC. `trigger: "receive"` pouze dekóduje, `periodic` generuje další virtuální rámce s periodou 10–60000 ms; události paddle/upshift/downshift jsou volitelné. Zdrojem generovaných signálů mohou být numerické/boolean hodnoty stavu modelu (rpm, speedKph, gear, throttle, brake, clutch, engineOn, coolantC, elapsed, shiftInProgress, revLimiter) a u událostí upshift/downshift. Obecný profil se nesnaží nahrazovat řadicí stavový automat. Tlačítko **Obnovit profil TUL** obnoví specializované dekódování letošní mapy včetně sdílených bitů.

```sh
npm test
npm run test:e2e
```

Testy pokrývají fyziku, stavový automat, byteové protokoly, screenshotové vektory, rozdíly starého parseru, SLCAN, UART parser a oba HTTP servery. Nativní integrační test vyžaduje C++17 překladač `c++` nebo proměnnou `CXX` a sestaví `src/main.cpp` do dočasné složky. Prohlížečové testy používají skutečný Chromium přes Playwright a kontrolují řízení, neutrálu, import/export, kalibraci, mobilní rozložení a testovací USB stream bez zápisu příkazů. Bez systémového Chromium použijte `npx playwright-core install chromium` nebo `CHROMIUM_PATH`. Ignorované snímky vznikají v `artifacts/`. Testy nenahrazují kalibraci fyziky ani měření na fyzické jednotce.
