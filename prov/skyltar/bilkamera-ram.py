# -*- coding: utf-8 -*-
"""Bygger bilkamera-bankens rutor ur agarens egna foton fran forarplats.

Varfor filen finns: bilderna sjalva far inte ligga i repot (se .gitignore i
samma mapp), men receptet maste, annars gar banken inte att aterskapa.

Vad den gor: varje portrattfoto beskars till liggande 16:9 kring skylten och
skalas till 1920x1080 -- exakt den upplosning appen filmar i (KAMERA i
js/plate.js). Da ar skylten lika manga pixlar hog i banken som i verkligheten,
och px-talen i resultatet gar att jamfora rakt av med vad kameran ser.

Facit ar avlast med ogat ur originalen i full upplosning. Sex bilder har
medvetet facit None: dar gar skylten inte att lasa ens for ett oga, och varje
lasning banken far ut ur dem ar ett uppfunnet nummer.

Kor fran prov/skyltar/ med bilderna i bilkamera/:
    python bilkamera-ram.py
Kraver: pip install pillow pillow-heif
"""
import json
import os

from PIL import Image
import pillow_heif

pillow_heif.register_heif_opener()

KALLA = "bilkamera"
UT = "bilkamera-ram"

# fil, skyltens mitt som andel av bildens bredd/hojd, facit, anteckning
BILDER = [
    ("IMG_0500.HEIC", 0.55,  0.33,  "CFD29W", "narbild, parkerad bil"),
    ("IMG_0501.HEIC", 0.55,  0.36,  "CFD29W", "narbild, parkerad bil"),
    ("IMG_0504.HEIC", 0.389, 0.465, "DFC51T", "taxi, nara"),
    ("IMG_0502.HEIC", 0.363, 0.376, "DFC51T", "taxi, medel"),
    ("IMG_0503.HEIC", 0.425, 0.339, "DFC51T", "taxi, langst bort"),
    ("cc9fdc6a.jpg",  0.488, 0.511, "MDM774", "Clio i rondell, nara"),
    ("2c948894.jpg",  0.484, 0.491, "MDM774", "Clio i rondell, langre"),
    ("40d72851.jpg",  0.475, 0.502, "WJB30K", "Peugeot-skapbil i ko"),
    ("4285508d.jpg",  0.451, 0.474, None, "vit Audi, rorelsesuddig - far EJ lasas"),
    ("377ebee2.jpg",  0.30,  0.52,  None, "trafik langt fram - far EJ lasas"),
    ("48786086.jpg",  0.50,  0.50,  None, "bil under bro - far EJ lasas"),
    ("7db8e452.jpg",  0.47,  0.50,  None, "vit bil langt fram - far EJ lasas"),
    ("7ec173df.jpg",  0.47,  0.50,  None, "vit bil under bro - far EJ lasas"),
    ("effc8dd3.jpg",  0.42,  0.52,  None, "motorvag, bil langt fram - far EJ lasas"),
]


def main():
    os.makedirs(UT, exist_ok=True)
    poster = []
    for fil, cx, cy, facit, notis in BILDER:
        sti = os.path.join(KALLA, fil)
        if not os.path.exists(sti):
            print("SAKNAS " + sti)
            continue
        im = Image.open(sti).convert("RGB")
        W, H = im.size
        # Hela bildbredden blir utsnittets bredd; hojden foljer 16:9.
        kh = round(W * 9 / 16)
        y0 = max(0, min(H - kh, round(cy * H - kh / 2)))
        ruta = im.crop((0, y0, W, y0 + kh)).resize((1920, 1080), Image.LANCZOS)
        namn = os.path.splitext(fil)[0] + ".jpg"
        ruta.save(os.path.join(UT, namn), quality=92)
        poster.append({"fil": namn, "facit": facit, "notis": notis,
                       "kalla": fil, "kallstorlek": [W, H],
                       "skala": round(1920 / W, 4)})
        print("%-22s %dx%d -> 1920x1080  facit %s" % (namn, W, H, facit))
    with open(os.path.join(UT, "facit.json"), "w", encoding="utf-8") as f:
        json.dump(poster, f, ensure_ascii=False, indent=2)
    print("%d rutor + facit.json i %s/" % (len(poster), UT))


if __name__ == "__main__":
    main()
