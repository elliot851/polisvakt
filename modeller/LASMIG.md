# Modellerna bakom skyltläsaren

Tre binärer som inte är skrivna här. Filen finns för att ingen ska behöva gissa
var de kommer ifrån eller om de får användas — det är en betalapp, och en
licens som smittar hela kodbasen är inte något man upptäcker efteråt.

| Fil | Storlek | Gör vad | Ursprung | Licens |
|---|---|---|---|---|
| `yolo-v9-t-640-plate.onnx` | 7,8 MB | hittar skylten i bildrutan | [ankandrew/open-image-models](https://github.com/ankandrew/open-image-models), `yolo-v9-t-640-license-plates-end2end.onnx` | MIT |
| `eu-ocr.onnx` | 5,0 MB | läser texten på ett skyltutklipp | [ankandrew/fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr), `european_mobile_vit_v2_ocr.onnx` | MIT |

384-varianten av detektorn låg här ett tag och ligger inte kvar: den är tre
gånger snabbare men blind för små skyltar (se mätningen längst ned), och 7,8 MB
död vikt i ett paket som varje användare laddar ner är inte gratis. Behövs den
igen heter den `yolo-v9-t-384-license-plates-end2end.onnx` i samma release.

`eu-ocr-config.yaml` följer med läsarmodellen och är dess sanning om alfabet
och indatastorlek — ändra inte den för hand.

## Varför inte Ultralytics

De mest spridda skyltdetektorerna är finjusterade YOLOv8/YOLOv11 från
Ultralytics, och de är **AGPL-3.0**. AGPL smittar över nätverket: en betaltjänst
som kör en AGPL-modell kan tvingas släppa hela sin källkod till varje användare.
Polisvakt säljs som abonnemang. Därför valdes MIT-modeller, som kostade en
halvtimmes letande och tar bort hela frågan.

## Vad de faktiskt gör, uppmätt

Detektorn: indata `float32 [1,3,640,640]`, brevlådeskalad RGB delad med 255,
utfyllnad 114 grå. Utdata `[N,7]` med NMS redan gjord:
`[bild, x1, y1, x2, y2, klass, poäng]`. **Poängen ligger sist, inte på plats 5**
— med fel kolumn blir varje låda 0,00 och det ser ut som att modellen inte
hittar något.

Läsaren: indata `uint8 [1,70,140,1]`, gråskala NHWC, **0–255 och inte 0–1**.
Utdata `float32 [1,333]` = 9 teckenplatser × 37 tecken
(`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_`, där `_` är utfyllnad och avslutar
numret). Softmax per plats ger en säkerhet per tecken; numrets säkerhet är den
**lägsta** över tecknen.

## Mätt på bilkamera-bänken (prov/skyltar/vagb.html), 2026-09-02

| Kedja | Rätt | Uppfunna | Hittade skylt |
|---|---|---|---|
| Gamla läsaren (blobbar + blått band + Tesseract) | 0/8 | 1 | 0/8 |
| ONNX-detektor + Tesseract | 4/8 | 2 | 8/8 |
| ONNX-detektor + ONNX-läsare | **6/8** | **0** | **8/8** |

De två som inte lästes är de två bildrutor där skylten är oläslig även för
ögat. Säkerhetsgrinden separerar rent: varje rätt läsning låg på 0,73–0,79,
varje fel på 0,09–0,26. Tröskeln 0,40 ligger mitt i ett tomt band — den är inte
intrimmad mot provet, och allt mellan 0,30 och 0,70 ger samma facit.

Hastighet på stationär dator, detektorn per bildruta: **380 ms på WASM, 84 ms på
WebGPU** med identiskt resultat. WebGPU kräver `ort.webgpu.min.js`, inte
`ort.min.js` — den senare säger "backend not found" och det låter som att
datorn saknar WebGPU fastän den inte gör det. 384-modellen är 136 ms men ser
inte små skyltar: bästa lådan sjönk från 0,70 till 0,04 på samma bild. Räckvidd
kostar upplösning, uppmätt.
