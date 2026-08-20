import time
from PIL import Image, ImageFilter

num_workloads = 12
width, height = 512, 512

print("========================================================================")
print(f"🐝 Running Unmodified Python Script ({num_workloads} Workloads)")
print("========================================================================")

t_start = time.perf_counter()
results = []

for i in range(1, num_workloads + 1):
    t_wkl = time.perf_counter()
    img = Image.new("RGBA", (width, height), (50 + i * 15, 100 + i * 10, 150 + i * 5, 255))
    
    # Pure unmodified PIL filter call — transparently intercepted by SwarmX
    result = img.filter(ImageFilter.BoxBlur(2))
    results.append(result)
    
    duration = time.perf_counter() - t_wkl
    print(f"  [{i:02d}/{num_workloads:02d}] Completed workload #{i} ({width}x{height}) in {duration:.3f}s -> {type(result).__name__}")

elapsed = time.perf_counter() - t_start
print("========================================================================")
print(f"✓ All {len(results)} workloads completed successfully in {elapsed:.3f}s total.")
print("========================================================================")
