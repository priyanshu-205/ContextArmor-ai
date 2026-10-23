import struct
import zlib
import os

def create_png(width, height, color_rgb):
    """Create a minimal valid PNG with a solid color."""
    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    
    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    
    # Image data - solid color with simple shield pattern
    r, g, b = color_rgb
    rows = []
    for y in range(height):
        row = b'\x00'  # filter type none
        for x in range(width):
            # Simple shield shape approximation
            cx = width / 2
            cy = height / 2
            dx = abs(x - cx) / (width / 2)
            dy = (y - cy * 0.2) / (height / 2)
            
            # Shield shape logic
            in_shield = False
            if y < height * 0.75:
                # Upper part: pentagon-like
                if dx + dy * 0.3 < 0.85:
                    in_shield = True
            else:
                # Lower part: pointed bottom
                progress = (y - height * 0.75) / (height * 0.25)
                if dx < (1 - progress) * 0.85:
                    in_shield = True
            
            if in_shield:
                # Shield color: white/light
                row += bytes([220, 225, 255])
            else:
                # Background: indigo
                row += bytes([r, g, b])
        rows.append(row)
    
    raw = b''.join(rows)
    compressed = zlib.compress(raw, 9)
    
    png = sig
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

# Create icons directory
icons_dir = os.path.join(os.path.dirname(__file__), 'icons')
os.makedirs(icons_dir, exist_ok=True)

# Indigo background color
bg_color = (99, 102, 241)  # #6366F1

for size in [16, 48, 128]:
    png_data = create_png(size, size, bg_color)
    path = os.path.join(icons_dir, f'icon{size}.png')
    with open(path, 'wb') as f:
        f.write(png_data)
    print(f'Created {path} ({len(png_data)} bytes)')

print('All icons created successfully!')
