"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_vite_1 = require("electron-vite");
const plugin_react_1 = __importDefault(require("@vitejs/plugin-react"));
exports.default = (0, electron_vite_1.defineConfig)({
    main: { plugins: [(0, electron_vite_1.externalizeDepsPlugin)()] },
    preload: { plugins: [(0, electron_vite_1.externalizeDepsPlugin)()] },
    renderer: { plugins: [(0, plugin_react_1.default)()] }
});
