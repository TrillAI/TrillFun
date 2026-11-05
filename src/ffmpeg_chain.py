"""Mirror of the ffmpeg conditioning chains in src/ffmpeg.js (benchmark only)."""

CHAINS = {
    "radio": (
        "highpass=f=280,lowpass=f=3200,afftdn=nr=14:nf=-40:tn=1,"
        "acompressor=threshold=-26dB:ratio=5:attack=4:release=140:makeup=6,"
        "alimiter=limit=0.95:level=disabled,volume=2dB"
    ),
    "phone": (
        "highpass=f=250,lowpass=f=3600,afftdn=nr=12:nf=-42:tn=1,"
        "acompressor=threshold=-24dB:ratio=4:attack=5:release=180:makeup=5,"
        "alimiter=limit=0.95:level=disabled"
    ),
    "clean": "highpass=f=70,alimiter=limit=0.97:level=disabled",
    "auto": (
        "highpass=f=120,lowpass=f=4200,afftdn=nr=8:nf=-40:tn=1,"
        "acompressor=threshold=-22dB:ratio=3:attack=5:release=180:makeup=4,"
        "dynaudnorm=f=300:g=6:p=0.8,alimiter=limit=0.97:level=disabled"
    ),
}


def chain_for(preset):
    return CHAINS.get(preset, CHAINS["auto"])
