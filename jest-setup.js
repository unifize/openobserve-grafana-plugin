// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';
import { TextDecoder, TextEncoder } from 'util';

Object.assign(globalThis, { TextDecoder, TextEncoder });
