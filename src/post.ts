// Jibnut
// Copyright (C) 2026 Frans Ljung
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * Post-processing: the scene is rendered in HDR into an off-screen image,
 * then
 *   - ambient occlusion (GTAO, worked out from the depth and normals on
 *     screen): soft contact shadows where the rider meets the snow, in the
 *     folds of the clothes, under the arms and round the boots;
 *   - bloom: only the brightest light (the sun, glare off sunlit snow and
 *     the helmet) spills a soft glow around it;
 *   - output: tone mapping and colour conversion for the screen.
 */

// Ambient occlusion: a small radius, for contact detail (the terrain's big
// shapes already have their occlusion baked in)
const AO = { radius: 0.7, distanceExponent: 1, thickness: 2, scale: 1.6, samples: 16 };
const AO_STRENGTH = 1;
// Bloom: in HDR, before tone mapping, so the threshold is in light units:
// only what's much brighter than lit snow glows
const BLOOM = { strength: 0.18, radius: 0.4, threshold: 9 };

export class Post {
  private readonly composer: EffectComposer;
  private readonly gtao: GTAOPass;
  private readonly bloom: UnrealBloomPass;
  private readonly renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // HDR (half float) and multisampled: antialiasing as before
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.gtao = new GTAOPass(scene, camera, size.x, size.y);
    this.gtao.updateGtaoMaterial(AO);
    this.gtao.blendIntensity = AO_STRENGTH;
    this.composer.addPass(this.gtao);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    this.composer.addPass(this.bloom);

    this.composer.addPass(new OutputPass());
  }

  /** Ambient occlusion on or off (it's the heaviest effect: off if frames drop). */
  set ambientOcclusion(on: boolean) {
    this.gtao.enabled = on;
  }

  /** After the window or the camera (field of view, near plane) changes. */
  resize(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);
  }

  render(): void {
    this.composer.render();
  }
}
