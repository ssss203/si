#!/usr/bin/env python3
"""Check PNG alpha channel without third-party deps (stdlib zlib only)."""
import sys
import zlib
import struct

def read_png(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'Not a PNG'
    pos = 8
    width = height = bit_depth = color_type = None
    idat = b''
    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos+4])[0]
        ctype = data[pos+4:pos+8]
        chunk = data[pos+8:pos+8+length]
        if ctype == b'IHDR':
            width, height, bit_depth, color_type = struct.unpack('>IIBB', chunk[:10])
        elif ctype == b'IDAT':
            idat += chunk
        pos += 12 + length
    return width, height, bit_depth, color_type, idat

def unfilter(scanlines, height, bpp, channels):
    stride = channels
    out = bytearray()
    prev = bytearray(stride * (len(scanlines[0]) // stride))
    for y, line in enumerate(scanlines):
        ft = line[0]
        raw = bytearray(line[1:])
        for i in range(len(raw)):
            a = raw[i - stride] if i >= stride else 0
            b = prev[i] if prev else 0
            c = prev[i - stride] if (prev and i >= stride) else 0
            if ft == 0:
                pass
            elif ft == 1:
                raw[i] = (raw[i] + a) & 0xFF
            elif ft == 2:
                raw[i] = (raw[i] + b) & 0xFF
            elif ft == 3:
                raw[i] = (raw[i] + (a + b) // 2) & 0xFF
            elif ft == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                raw[i] = (raw[i] + pr) & 0xFF
            else:
                raise ValueError(f'bad filter {ft}')
        out += raw
        prev = raw
    return bytes(out)

def main():
    path = sys.argv[1]
    w, h, bit, ct, idat = read_png(path)
    print(f'size={w}x{h} bit_depth={bit} color_type={ct}')
    channels = {0:1, 2:3, 3:1, 4:2, 6:4}.get(ct)
    if channels is None:
        print('UNKNOWN color type'); return
    bpp = channels
    raw = zlib.decompress(idat)
    stride = 1 + w * bpp
    rows = [raw[y*stride:(y+1)*stride] for y in range(h)]
    px = unfilter(rows, h, bpp, channels)
    has_alpha = ct in (4, 6)
    if not has_alpha:
        print('NO_ALPHA_CHANNEL -> not transparent (RGB)')
        # sample corner color to hint background
        def px_at(x, y):
            off = (y * w + x) * channels
            return tuple(px[off:off+channels])
        print('sample top-left:', px_at(0, 0))
        print('sample top-right:', px_at(w-1, 0))
        return
    alpha_idx = channels - 1
    total = w * h
    cnt0 = cnt255 = cntmid = 0
    for i in range(0, len(px), channels):
        a = px[i + alpha_idx]
        if a == 0: cnt0 += 1
        elif a == 255: cnt255 += 1
        else: cntmid += 1
    print(f'alpha: fully_transparent={cnt0} ({cnt0/total:.1%}) opaque={cnt255} ({cnt255/total:.1%}) partial={cntmid} ({cntmid/total:.1%})')
    if cnt0 / total > 0.02 and cnt255 / total > 0.05:
        print('REAL_ALPHA_OK')
    else:
        print('ALPHA_SUSPECT: little/no transparency found')

if __name__ == '__main__':
    main()
