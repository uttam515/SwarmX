from PIL import Image, ImageFilter

img = Image.new("RGBA", (512, 512), (100, 150, 200, 255))

print("Before:", type(img), img.size, img.mode)

result = img.filter(ImageFilter.BoxBlur(2))

print("After:", type(result), result.size, result.mode)
print("Pixel:", result.getpixel((256, 256)))

result.save("/tmp/swarmx_boxblur_test.png")

print("SUCCESS")
