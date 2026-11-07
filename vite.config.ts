// Jibnut
// Copyright (C) 2026 Frans Ljung
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built game works wherever it's hosted
  // (GitHub Pages serves it from /<repo-name>/, not the site root)
  base: './',
});
