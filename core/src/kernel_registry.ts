import { KernelDefinition } from './types';

export class KernelRegistry {
  private static instance: KernelRegistry;
  private kernels: Map<string, KernelDefinition> = new Map();

  private constructor() {
    this.registerDefaultKernels();
  }

  public static getInstance(): KernelRegistry {
    if (!KernelRegistry.instance) {
      KernelRegistry.instance = new KernelRegistry();
    }
    return KernelRegistry.instance;
  }

  private registerDefaultKernels(): void {
    // Phase 1 Certified Flagship Kernel: Box Blur
    this.registerKernel({
      kernelId: 'image_filter_box_blur_v1',
      version: '1.0.0',
      domain: 'IMAGE_PROCESSING',
      description: '2D Box Blur filter on planar RGBA uint8 pixel buffers with radius parameter',
      inputFormat: 'RAW_PLANAR_RGBA_UINT8',
      outputFormat: 'RAW_PLANAR_RGBA_UINT8',
      minBeneficialBytes: 65536, // ~128x128 RGBA image minimum
      defaultToleranceValidator: 'IMAGE_PIXEL_DELTA',
      supportedPlatforms: ['darwin', 'windows', 'linux', 'ios', 'android'],
      estimatedComplexityFlopsPerByte: 18.0
    });

    // Phase 1 Certified Kernel: Gaussian Blur
    this.registerKernel({
      kernelId: 'image_filter_gaussian_blur_v1',
      version: '1.0.0',
      domain: 'IMAGE_PROCESSING',
      description: '2D Gaussian Blur convolution on planar RGBA uint8 pixel buffers',
      inputFormat: 'RAW_PLANAR_RGBA_UINT8',
      outputFormat: 'RAW_PLANAR_RGBA_UINT8',
      minBeneficialBytes: 65536,
      defaultToleranceValidator: 'IMAGE_PIXEL_DELTA',
      supportedPlatforms: ['darwin', 'windows', 'linux', 'ios', 'android'],
      estimatedComplexityFlopsPerByte: 36.0
    });

    // Phase 1 Certified Kernel: Matrix Multiplication (Float32)
    this.registerKernel({
      kernelId: 'matrix_multiply_v1',
      version: '1.0.0',
      domain: 'NUMERICAL_COMPUTATION',
      description: '2D General Matrix Multiplication (GEMM) on float32 planar buffers',
      inputFormat: 'FLOAT32_ARRAY',
      outputFormat: 'FLOAT32_ARRAY',
      minBeneficialBytes: 131072, // ~128x128 matrices minimum
      defaultToleranceValidator: 'NUMERIC_TOLERANCE',
      supportedPlatforms: ['darwin', 'windows', 'linux'],
      estimatedComplexityFlopsPerByte: 128.0
    });

    // Phase 6 Certified Flagship Kernel: Video Frame Analysis (Luminance, Edge Gradient, and Motion Energy)
    this.registerKernel({
      kernelId: 'video_frame_analysis_v1',
      version: '1.0.0',
      domain: 'IMAGE_PROCESSING',
      description: 'Multi-frame sequential luminance, gradient edge density, blur score, and motion energy analysis',
      inputFormat: 'RAW_PLANAR_RGBA_UINT8',
      outputFormat: 'JSON_METADATA_ARRAY',
      minBeneficialBytes: 65536,
      defaultToleranceValidator: 'NUMERIC_TOLERANCE',
      supportedPlatforms: ['darwin', 'windows', 'linux'],
      estimatedComplexityFlopsPerByte: 32.0
    });
  }

  public registerKernel(kernel: KernelDefinition): void {
    this.kernels.set(kernel.kernelId, kernel);
  }

  public getKernel(kernelId: string): KernelDefinition | undefined {
    return this.kernels.get(kernelId);
  }

  public isCertified(kernelId: string): boolean {
    return this.kernels.has(kernelId);
  }

  public isPlatformSupported(kernelId: string, osType: 'darwin' | 'windows' | 'linux' | 'ios' | 'android'): boolean {
    const kernel = this.kernels.get(kernelId);
    if (!kernel) return false;
    return kernel.supportedPlatforms.includes(osType);
  }

  public listKernels(): KernelDefinition[] {
    return Array.from(this.kernels.values());
  }
}
