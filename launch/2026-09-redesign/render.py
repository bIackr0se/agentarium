"""Reproducible 36-second product film. Composites captured Demo UI and authored assets.
No remote services, private source data, or borrowed soundtrack.
"""
from pathlib import Path
import math
import hashlib
import json
import subprocess
import wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
W, H, FPS, DURATION = 1920, 1080, 30, 36
CREAM, SEA, INK, GREEN = '#fbf8f0', '#f1eddc', '#26352b', '#254b38'
FONT = OUT / 'SpaceGrotesk-Medium.ttf'
fonts = {n: ImageFont.truetype(str(FONT), n) for n in [22,26,28,32,40,48,56,72,90,104,120,140,160]}
arts = {'village': Image.open(ROOT / 'public/assets/sculpted/village.webp').convert('RGBA'),
        'robot': Image.open(OUT / 'robot-film.webp').convert('RGBA')}
shots = {n: Image.open(OUT / f'captures/{n}.png').convert('RGB') for n in ['desktop','project','evidence','replay','replay-earlier','connect']}
layout = []


def input_digests():
    inputs = [Path(__file__), FONT, OUT / 'robot-film.webp', OUT / 'requirements.txt',
              ROOT / 'public/assets/sculpted/village.webp']
    inputs.extend(OUT / f'captures/{key}.png' for key in shots)
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(inputs)}


def export_receipt():
    movie = OUT / 'agentarium-launch.mp4'
    return {'inputs': input_digests(), 'video_sha256': hashlib.sha256(movie.read_bytes()).hexdigest()}

def place(kind, label, bounds):
    layout.append({'kind': kind, 'label': label, 'bounds': tuple(bounds)})


def ease(x):
    return 1 - (1-max(0,min(1,x)))**3


def text(draw, xy, value, size=90, fill=INK, spacing=8):
    place('text', value, draw.multiline_textbbox(xy, value, font=fonts[size], spacing=spacing))
    draw.multiline_text(xy, value, font=fonts[size], fill=fill, spacing=spacing, stroke_width=0)


scaled_art = {n: arts[n].resize((960,960),Image.Resampling.LANCZOS) for n in arts}

def island(canvas, name, x, y, size=960):
    a = scaled_art[name] if size == 960 else arts[name].resize((size,size),Image.Resampling.LANCZOS)
    if a.getextrema()[3][0] == 255:
        raise ValueError(f'{name}: scene artwork must have transparency')
    canvas.paste(a,(int(x),int(y)),a)


shot_sizes = {}

def screen(canvas, key, x, y, width, crop=None):
    cache_key = (key,width,crop)
    if cache_key not in shot_sizes:
        im = shots[key]
        if crop: im = im.crop(crop)
        im = im.resize((width,round(im.height*width/im.width)),Image.Resampling.LANCZOS)
        shot_sizes[cache_key] = im
    im = shot_sizes[cache_key]
    place('screen', key, (x-2,y-2,x+im.width+2,y+im.height+2))
    d=ImageDraw.Draw(canvas)
    d.rounded_rectangle((x-2,y-2,x+im.width+2,y+im.height+2),radius=20,fill='#c6cfb8')
    mask=Image.new('L',im.size);ImageDraw.Draw(mask).rounded_rectangle((0,0,*im.size),radius=18,fill=255)
    canvas.paste(im,(int(x),int(y)),mask)


def stamp(d, dark=False):
    text(d,(70,1009),'AGENTARIUM',22,CREAM if dark else GREEN)
    text(d,(1510,1009),'Edited Demo walkthrough',22,CREAM if dark else '#626858')


def frame(t):
    layout.clear()
    dark = 25 <= t < 30
    canvas=Image.new('RGB',(W,H),GREEN if dark else SEA)
    d=ImageDraw.Draw(canvas)
    if t<3:
        p=ease(t/.75)
        island(canvas,'village',860+80*(1-p),120,960)
        text(d,(95,285+55*(1-p)),'Your agents.',120)
        if t>.7: text(d,(95,435+45*(1-ease((t-.7)/.6))),'A world of\ntheir own.',104)
    elif t<7:
        p=ease((t-3)/.6)
        text(d,(85,75),'Meet Agentarium.',90)
        screen(canvas,'desktop',650,230+90*(1-p),1200)
        text(d,(87,540),'Your team,\nin view.',72)
    elif t<11:
        p=ease((t-7)/.55)
        text(d,(80,270),'See the team.\nFind the task.',90)
        text(d,(85,535),'Projects become places.',32,'#626858')
        screen(canvas,'project',770+40*(1-p),170,1080)
    elif t<15:
        p=ease((t-11)/.55)
        screen(canvas,'desktop',70,130,1040,crop=(20,50,847,614))
        text(d,(1150,220+45*(1-p)),'Know what\nneeds you.',90)
        screen(canvas,'desktop',1150,530,660,crop=(847,60,1114,210))
    elif t<20:
        p=ease((t-15)/.55)
        text(d,(80,240),'From status\nto evidence.',104)
        text(d,(85,515),'Open the recorded event trail.',32,'#626858')
        screen(canvas,'evidence',1100+100*(1-p),70,700,crop=(765,0,1114,440))
    elif t<25:
        p=ease((t-20)/.55)
        text(d,(80,265),'Rewind\nthe work.',120)
        text(d,(85,565),'See what was known, and when.',32,'#626858')
        screen(canvas,'replay' if t < 22.5 else 'replay-earlier',790+40*(1-p),95,1050)
    elif t<30:
        q=t-25
        words=['Local.','Read-only.','Yours.']
        for i,word in enumerate(words):
            if q>i*.55:
                text(d,(100,175+i*168+45*(1-ease((q-i*.55)/.55))),word,140,CREAM)
        if q>1.7:
            text(d,(110,815),'Codex  /  JSON  /  JSONL',40,'#dce6c5')
        island(canvas,'robot',1040,80+15*math.sin(t*1.1),800)
    elif t<33:
        p=ease((t-30)/.55)
        text(d,(80,255),'Connect your\nlocal source.',90)
        text(d,(85,510),'A read-only view of your work.',32,'#626858')
        screen(canvas,'connect',790+40*(1-p),150,1060,crop=(200,50,940,540))
    else:
        p=ease((t-33)/.7)
        island(canvas,'village',570,295+50*(1-p),780)
        label='Agentarium.'
        box=d.textbbox((0,0),label,font=fonts[140])
        text(d,((W-(box[2]-box[0]))/2,85),label,140)
        subtitle='Your team, in view.'
        box=d.textbbox((0,0),subtitle,font=fonts[40])
        text(d,((W-(box[2]-box[0]))/2,250),subtitle,40,'#626858')
    stamp(d,dark)
    return canvas


def soundtrack():
    sr=48000; length=sr*DURATION
    data=np.zeros((length,2),dtype=np.float64)
    rng=np.random.default_rng(22)
    def add(at,freq,duration,level,pan=.5,plucked=True):
        start=int(at*sr);n=min(int(duration*sr),length-start)
        if n<=0:return
        tt=np.arange(n)/sr
        env=(1-np.exp(-tt*100))*np.exp(-tt*(3.3 if plucked else 1.2)/duration)
        env*=np.minimum(1,(duration-tt)/.08)
        sound=(np.sin(2*np.pi*freq*tt)+.21*np.sin(2*np.pi*2*freq*tt)+.06*np.sin(2*np.pi*3*freq*tt))*env*level
        data[start:start+n,0]+=sound*math.cos(pan*np.pi/2)
        data[start:start+n,1]+=sound*math.sin(pan*np.pi/2)
    chords=[[57,60,64,67],[53,57,60,64],[55,59,62,67],[52,55,59,64]]
    for beat in range(72):
        at=beat*.5
        chord=chords[(beat//8)%4]
        if beat%4==0:add(at,440*2**((chord[0]-12-69)/12),1.8,.16,plucked=False)
        note=chord[[0,2,1,3,2,1,3,2][beat%8]]+12
        add(at,440*2**((note-69)/12),1.4,.115,.25 if beat%2 else .75)
        if beat%2==0:
            n=int(.16*sr);tt=np.arange(n)/sr
            kick=np.sin(2*np.pi*(46*tt+32*.035*(1-np.exp(-tt/.035))))*np.exp(-tt*27)*.10
            a=int(at*sr);data[a:a+n]+=kick[:,None]
        n=int(.065*sr);a=int((at+.25)*sr)
        if a+n<length:
            hat=rng.standard_normal(n)*np.exp(-np.arange(n)/sr*90)*.009
            data[a:a+n]+=hat[:,None]
    # Quiet musical delays, not source audio.
    delay=int(.25*sr);data[delay:]+=data[:-delay].copy()*.12
    fade=np.minimum(1,np.arange(length)/(sr*.25))*np.minimum(1,(length-np.arange(length))/(sr*1.5))
    data*=fade[:,None]
    peak=np.max(np.abs(data));data*=.75/max(peak,.75)
    with wave.open(str(OUT/'original-score.wav'),'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(sr);f.writeframes((data*32767).astype('<i2').tobytes())


if __name__=='__main__':
    (OUT/'frames').mkdir(exist_ok=True)
    soundtrack()
    for i in [1,4,8,12,17,22,27,31,34]: frame(i).save(OUT/f'frames/scene-{i:02d}.jpg',quality=94)
    cmd=['ffmpeg','-y','-v','error','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-i',str(OUT/'original-score.wav'),'-c:v','libx264','-preset','fast','-threads','2','-crf','18','-pix_fmt','yuv420p','-af','loudnorm=I=-16:TP=-1.5:LRA=9','-ar','48000','-c:a','aac','-b:a','192k','-movflags','+faststart','-t',str(DURATION),str(OUT/'agentarium-launch.mp4')]
    process=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    try:
        for i in range(FPS*DURATION):
            process.stdin.write(frame(i/FPS).tobytes())
            if i%(FPS*6)==0: print(f'Rendered {i//FPS}/{DURATION}s',flush=True)
    finally:
        process.stdin.close()
    if process.wait()!=0: raise SystemExit('Video encoder failed')
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(OUT/'agentarium-launch.mp4'),
                    '-f', 'null', '-'], check=True)
    (OUT/'export.json').write_text(json.dumps(export_receipt(), indent=2) + '\n')
    print(OUT/'agentarium-launch.mp4')
