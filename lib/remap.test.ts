import { parse, remapWindows } from './parser';
import { test, expect } from 'bun:test';
import assert from 'assert';

test('remap', async () => {
  const parsed = parse('1.1.3/w00933d1ulgmZ__2v7u5E___2v7u5EAeNrLzCvLz05NUUguSizOcKoMSMzLTNbQVMhIzEvJSS0CAK/LCxc=');
  console.log(parsed);
  assert(parsed);
  expect(parsed.os).toBe('windows');
  expect(parsed.arch).toBe('x86_64');
  expect(parsed.commitish).toBe('00933d');
  const remapped = await remapWindows(parsed);
  console.log(remapped);
  expect(remapped).toEqual({
    os: "windows",
    arch: "x86_64",
    commit: "00933d597a1fb6f6136857eb6517626746dcb339",
    message: 'invoked crashByPanic() handler',
    addresses: [
      {
        remapped: true,
        file: "src/bun.js/api/BunObject.zig",
        line: 3372,
        function: "crashByPanic(JSGlobalObject*, CallFrame*)",
        object: "bun",
      }, {
        remapped: false,
        object: "js",
        address: 0,
      }, {
        remapped: false,
        object: "js",
        address: 0,
      }, {
        remapped: false,
        object: "bun",
        address: 80442619,
      }, {
        remapped: false,
        object: "js",
        address: 0,
      }, {
        remapped: false,
        object: "js",
        address: 0,
      }, {
        remapped: false,
        object: "js",
        address: 0,
      }, {
        remapped: false,
        object: "bun",
        address: 80442619,
      }
    ],
  });
})