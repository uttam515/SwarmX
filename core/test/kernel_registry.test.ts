import { expect } from 'chai';
import { KernelRegistry } from '../src/kernel_registry';

describe('KernelRegistry & Workload IR Tests (Phase A)', () => {
  const registry = KernelRegistry.getInstance();

  it('should have certified image_filter_box_blur_v1 kernel registered', () => {
    expect(registry.isCertified('image_filter_box_blur_v1')).to.be.true;
    const kernel = registry.getKernel('image_filter_box_blur_v1');
    expect(kernel).to.not.be.undefined;
    expect(kernel!.domain).to.equal('IMAGE_PROCESSING');
    expect(kernel!.inputFormat).to.equal('RAW_PLANAR_RGBA_UINT8');
    expect(kernel!.outputFormat).to.equal('RAW_PLANAR_RGBA_UINT8');
  });

  it('should reject uncertified kernels', () => {
    expect(registry.isCertified('custom_arbitrary_python_lambda')).to.be.false;
    expect(registry.getKernel('custom_arbitrary_python_lambda')).to.be.undefined;
  });

  it('should check platform support correctly', () => {
    expect(registry.isPlatformSupported('image_filter_box_blur_v1', 'darwin')).to.be.true;
    expect(registry.isPlatformSupported('image_filter_box_blur_v1', 'windows')).to.be.true;
  });
});
