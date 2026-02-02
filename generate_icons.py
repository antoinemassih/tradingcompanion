from PIL import Image, ImageDraw

def create_icon(size, filename):
    # Create image with transparent background
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Calculate dimensions
    margin = size // 8
    line_width = max(2, size // 16)

    # Draw orange/amber background circle
    draw.ellipse(
        [margin, margin, size - margin, size - margin],
        fill=(255, 152, 0, 255)  # Orange
    )

    # Draw chart line icon (upward trend)
    center = size // 2
    points = [
        (margin + size//6, center + size//6),
        (center - size//10, center - size//10),
        (center + size//10, center),
        (size - margin - size//6, center - size//4)
    ]

    # Draw white line
    for i in range(len(points) - 1):
        draw.line([points[i], points[i+1]], fill=(255, 255, 255, 255), width=line_width)

    # Draw horizontal alert line
    y_line = center - size//8
    draw.line(
        [(margin + size//8, y_line), (size - margin - size//8, y_line)],
        fill=(255, 255, 255, 200),
        width=max(1, line_width // 2)
    )

    img.save(filename, 'PNG')
    print(f"Created {filename}")

# Create icons in different sizes
create_icon(16, r'C:\Users\USER\tradingview-alert-extension\icons\icon16.png')
create_icon(48, r'C:\Users\USER\tradingview-alert-extension\icons\icon48.png')
create_icon(128, r'C:\Users\USER\tradingview-alert-extension\icons\icon128.png')

print("All icons created successfully!")
