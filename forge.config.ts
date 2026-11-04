import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { VitePlugin } from "@electron-forge/plugin-vite";

const makers: ForgeConfig["makers"] = [
  new MakerZIP({}, ["darwin", "win32"]),
  new MakerDMG({ format: "ULFO" }, ["darwin"]),
];

// Windows 安装器（Squirrel）需要 Windows 环境制作；本机无 Windows 硬件，
// 安装器制作与启动标「待补验」，补验方式见 PR 与 docs/基线记录.md。
// 静态引入仅为条件实例化，macOS 上不会执行其制作逻辑。
if (process.platform === "win32") {
  makers.push(new MakerSquirrel({}));
}

const config: ForgeConfig = {
  packagerConfig: {
    name: "PaperWeave",
    appBundleId: "com.wwq0327.paperweave",
  },
  rebuildConfig: {},
  makers,
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.mts",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
  ],
};

export default config;
