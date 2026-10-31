# Formula Lab — nativní desktop pro Windows 11

## Sestavení ve Visual Studiu 2022

Potřebujete Windows 11 x64, Visual Studio 2022 **17.10+** s workloadem „Desktop development with C++“ (MSVC v143 a Windows SDK), CMake **3.28+** a Qt **6.8.x MSVC 2022 64-bit** s modulem **Qt Serial Port**. Qt Test je součástí Qt Base. Nemíchejte Qt pro MinGW s MSVC.

V PowerShellu upravte cestu podle instalace:

```powershell
$env:QTDIR = 'C:\Qt\6.8.3\msvc2022_64'
cmake --preset windows-vs2022
cmake --build --preset windows-release
$env:PATH = "$env:QTDIR\bin;$env:PATH"
ctest --preset windows-release
.\build\windows-vs2022\Release\simulator_jednotky.exe
```

Otevřete vygenerované `build/windows-vs2022/simulator_jednotky.sln`, zvolte Release/x64 a nastavte `simulator_jednotky` jako spouštěcí projekt. Alternativně otevřete kořenovou složku projektu a použijte CMake preset. Při změně toolchainu použijte novou build složku.

Výchozí aplikace má vlastní Qt Widgets okno, nativní dialogy a COM port. Nepoužívá prohlížeč, WebView, Node.js, HTML/CSS ani HTTP server. Fyzika a protokoly jsou vložené v binárce a běží uvnitř procesu v QuickJS-ng. První konfigurace stáhne QuickJS-ng 0.10.1 z `codeload.github.com` a ověří připnutý SHA-256; runtime síť nepotřebuje.

Přenositelnou složku připravíte:

```powershell
cmake --install build/windows-vs2022 --config Release --prefix build/windows-package
.\build\windows-package\simulator_jednotky.exe
```

Qt deployment přibalí Qt DLL a plugin `qwindows.dll`. Na cílovém PC může být potřeba Microsoft Visual C++ Redistributable 2015–2022 x64. Není nutné kopírovat checkout, JS soubory ani Node.js. Při distribuci dodržte licenci své instalace Qt (LGPLv3 nebo komerční); MIT licence QuickJS-ng se instaluje do `licenses/`.

## Simulace a záznamy

Záložka **Simulace** nabízí otáčky, rychlost, stupeň, teplotu, pedály, start/stop motoru, řazení, neutrál, pauzu a reset. Graf ukazuje posledních 30 s otáček a rychlosti. I/E/Q/N ovládají motor/řazení, mezerník/B/C dočasně drží pedály. Uvolnění klávesy nebo ztráta aktivity okna obnoví předchozí hodnotu. Zkratky nezasahují do editace textu, výběrových polí, posuvníků ani kalibračního dialogu.

Panel jednotky ukazuje FET1/FET2, vstupní RPM, prodlevu a odjištění. Lze přepnout původní parser pro diagnostiku jeho rozporů a vynutit čidlo „mezi stupni (7)“. Příkazy 1/2/0x40 a maska 0x43 zůstávají neověřeným předpokladem; fyzika a ideální pneumatika jsou model. Žádný virtuální pulz neovládá fyzický ventil.

**Model / kalibrace** je nativní JSON editor všech původních parametrů vozidla, převodů, časů a limitů jednotky i CAN profilu. Import/export používá stejnou kalibraci schemaVersion 1 jako webová varianta. Všechny části se ověří před použitím. `shiftingUnit.ratios[1..6]` musí odpovídat `vehicle.gearRatios`; pomocný poměr N je `500 * gearRatios[0] / rpmLowerLimit`. Během editace stojí virtuální čas, sériový příjem pokračuje. Před změnou kalibrace/profilu odpojte port. Pro uchování konfiguraci exportujte.

**CAN monitor** uchovává 5000 rámců a zobrazuje posledních 200 odpovídajících ID/datovému a směrovému filtru. Nabízí samostatnou pauzu záznamu, vymazání, import Classical CAN candump a UART textu, export candump/úplných JSON metadat, vlastní byteový profil a obnovení TUL profilu. Ruční import funguje i při pozastaveném záznamu. Reset vozu nemaže záznam. Virtuální sběrnice má periodu 50 ms; rámce se do adaptéru neposílají.

## USB/COM port při 115200 baud

1. Připojte desku k **PC, na kterém běží desktopová aplikace**. Ve Správci zařízení ověřte COM port. CP2102 může vyžadovat oficiální ovladač Silicon Labs CP210x.
2. **Obnovit porty** načte nativní seznam s názvem, popisem a dostupnými VID/PID.
3. Zvolte **USB jednotky · debug UART**, port a **Připojit**. Nastavení je **115200 baud, 8N1, bez flow control**.
4. **Sériový debug výpis** zobrazuje text. CAN monitor rekonstruuje `ID is 1536` / `Data byte 0 = 64` jako `UART RX* / uart0`. Port je otevřen `ReadOnly`; žádné UART příkazy se neposílají. DTR/RTS se úmyslně neaktivují, USB ovladač přesto může při otevření desku resetovat.
5. **Odpojit** zavře port. Při odpojení kabelu/chybě I/O se spojení uzavře a lze je znovu otevřít. Port nesmí držet jiný Serial Monitor nebo PlatformIO.

Qt Serial Port čte asynchronně. UTF-8 a fragmentované řádky řeší průběžný decoder a původní UART parser. Po 150 ms klidu se dokončí jen ukončené řádky; rozdělený číselný údaj se nezkrátí. Výpis neobsahuje skutečné DLC ani CAN timestamp: hvězdička značí odvozené DLC a živý čas je přijetí na PC. U importu UART je původní čas neznámý, candump rezervuje nulu. Nejde o bezeztrátový CAN záznam.

Samostatný externí **SLCAN** adaptér má vlastní režim. Aplikace vyžaduje potvrzení `C`, `S0–S8` dle profilu a `L` (listen-only), nepoužívá aktivní `O` a nevysílá datové rámce. Tento režim není určen pro CP2102 debug port jednotky. Externí příjem pouze monitoruje a neřídí virtuální ani skutečný pohon. Nic se neflashuje.

## Architektura a ověření

- `desktop/main.cpp`, `window.cpp`: C++ Qt Widgets, QPainter graf, nativní dialogy a tabulka.
- `desktop/serial.cpp`: Qt Serial Port, read-only UART a potvrzovaný SLCAN listen-only.
- `desktop/controller.js`: virtuální čas, sběrnice, záznamy a kalibrace bez DOM.
- Přímo sdílené `src/simulator.js`, `shifting-unit.js`, `can.js`, `tul-protocol.js`, `tul-serial.js` jsou vložené přes Qt Resources. Importovaná data se parsují jako JSON/text, nevyhodnocují se jako kód. Engine nemá OS/souborové/síťové bindings a má omezenou paměť, stack i dobu volání.

`ctest --preset windows-release` testuje start, akceleraci/brzdění, řazení/neutrál, pauzu, fragmentaci UART, DLC metadata, transakční kalibraci, vlastní profil a ovládání nativních widgetů. Linux navíc ověřuje Qt Serial Port přes skutečný pseudoterminál, nulový UART zápis a odpojení/reconnect. Skutečný CP2102 a Windows ovladač vyžadují ověření na zařízení.

Původní testy: `npm ci`, `npm test` a `npm run test:e2e` (webová varianta; Node.js dle `.node-version`). CI obsahuje Windows 2022/MSVC sestavení, desktopové testy a instalaci balíčku. Připravený CI postup sám není dokladem úspěšného běhu na Windows.

Pro Linux s Qt 6.8+ a Qt Serial Port: `cmake -S . -B build/desktop -DCMAKE_BUILD_TYPE=Release`, `cmake --build build/desktop --parallel 2`, `QT_QPA_PLATFORM=offscreen ctest --test-dir build/desktop --output-on-failure`. Pro běžné spuštění GUI proměnnou `offscreen` nepoužívejte.
