from PIL import Image, ImageFilter
import time

print("========================================================================")
print("🐝 Standard Python Image Processing (Zero SwarmX Code)")
print("========================================================================")

# 1. Create a standard high-resolution RGBA test image
image = Image.new(
    "RGBA",
    (1024, 1024),
    (100, 150, 200, 255)
)

print(f"Original image: {type(image).__name__} ({image.size[0]}x{image.size[1]} {image.mode})")

# 2. Standard PIL filter invocation — Zero SwarmX imports or decorators
# When SwarmX is active in VS Code, this is intercepted and executed on the cluster.
t0 = time.perf_counter()
result = image.filter(ImageFilter.BoxBlur(4))
elapsed = time.perf_counter() - t0

print(f"Filtered result: {type(result).__name__} ({result.size[0]}x{result.size[1]} {result.mode})")
print(f"Execution time:  {elapsed:.3f}s ({elapsed*1000:.1f}ms)")
print(f"Center pixel:    {result.getpixel((512, 512))}")
print("========================================================================")
print("✓ Completed successfully with authentic PIL result.")
print("========================================================================")
