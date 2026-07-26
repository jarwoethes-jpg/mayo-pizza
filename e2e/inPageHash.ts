import type { Page } from "@playwright/test";

/** Hashes one OPFS file in bounded-size slices inside the browser page. */
export const hashOpfsFileInPage = async (fileName: string): Promise<string> => {
  const roundRight = (value: number, bits: number): number =>
    (value >>> bits) | (value << (32 - bits));
  // Known answer: SHA-256("abc") =
  // ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.
  // This K table matches @noble/hashes/sha2.js, including K[4] = 0x3956c25b.
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const at = (values: ArrayLike<number>, index: number): number =>
    values[index] ?? 0;
  class Sha256 {
    private readonly state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
    private readonly words = new Uint32Array(64);
    private readonly buffer = new Uint8Array(64);
    private bufferLength = 0;
    private byteLength = 0;

    public update(input: Uint8Array): void {
      this.byteLength += input.byteLength;
      let offset = 0;
      if (this.bufferLength > 0) {
        const copied = Math.min(64 - this.bufferLength, input.byteLength);
        this.buffer.set(input.subarray(0, copied), this.bufferLength);
        this.bufferLength += copied;
        offset += copied;
        if (this.bufferLength === 64) {
          this.compress(this.buffer);
          this.bufferLength = 0;
        }
      }
      while (offset + 64 <= input.byteLength) {
        this.compress(input.subarray(offset, offset + 64));
        offset += 64;
      }
      if (offset < input.byteLength) {
        this.buffer.set(input.subarray(offset));
        this.bufferLength = input.byteLength - offset;
      }
    }

    public digest(): string {
      const paddedLength = Math.floor((this.bufferLength + 9 + 63) / 64) * 64;
      const padded = new Uint8Array(paddedLength);
      padded.set(this.buffer.subarray(0, this.bufferLength));
      padded[this.bufferLength] = 0x80;
      const bitLength = this.byteLength * 8;
      const view = new DataView(padded.buffer);
      view.setUint32(
        paddedLength - 8,
        Math.floor(bitLength / 0x1_0000_0000),
        false,
      );
      view.setUint32(paddedLength - 4, bitLength >>> 0, false);
      for (let offset = 0; offset < paddedLength; offset += 64) {
        this.compress(padded.subarray(offset, offset + 64));
      }
      return Array.from(this.state, (word) =>
        word.toString(16).padStart(8, "0"),
      ).join("");
    }

    private compress(block: Uint8Array): void {
      for (let index = 0; index < 16; index += 1) {
        const offset = index * 4;
        this.words[index] =
          ((at(block, offset) << 24) |
            (at(block, offset + 1) << 16) |
            (at(block, offset + 2) << 8) |
            at(block, offset + 3)) >>>
          0;
      }
      for (let index = 16; index < 64; index += 1) {
        const first = at(this.words, index - 15);
        const second = at(this.words, index - 2);
        const smallSigma0 =
          roundRight(first, 7) ^ roundRight(first, 18) ^ (first >>> 3);
        const smallSigma1 =
          roundRight(second, 17) ^ roundRight(second, 19) ^ (second >>> 10);
        this.words[index] =
          (at(this.words, index - 16) +
            smallSigma0 +
            at(this.words, index - 7) +
            smallSigma1) >>>
          0;
      }

      let a = at(this.state, 0);
      let b = at(this.state, 1);
      let c = at(this.state, 2);
      let d = at(this.state, 3);
      let e = at(this.state, 4);
      let f = at(this.state, 5);
      let g = at(this.state, 6);
      let h = at(this.state, 7);
      for (let index = 0; index < 64; index += 1) {
        const bigSigma1 =
          roundRight(e, 6) ^ roundRight(e, 11) ^ roundRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const first =
          (h +
            bigSigma1 +
            choice +
            at(constants, index) +
            at(this.words, index)) >>>
          0;
        const bigSigma0 =
          roundRight(a, 2) ^ roundRight(a, 13) ^ roundRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const second = (bigSigma0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + first) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (first + second) >>> 0;
      }
      this.state[0] = (at(this.state, 0) + a) >>> 0;
      this.state[1] = (at(this.state, 1) + b) >>> 0;
      this.state[2] = (at(this.state, 2) + c) >>> 0;
      this.state[3] = (at(this.state, 3) + d) >>> 0;
      this.state[4] = (at(this.state, 4) + e) >>> 0;
      this.state[5] = (at(this.state, 5) + f) >>> 0;
      this.state[6] = (at(this.state, 6) + g) >>> 0;
      this.state[7] = (at(this.state, 7) + h) >>> 0;
    }
  }

  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle(fileName)).getFile();
  const hash = new Sha256();
  const sliceSize = 64 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += sliceSize) {
    hash.update(
      new Uint8Array(
        await file.slice(offset, offset + sliceSize).arrayBuffer(),
      ),
    );
  }
  return hash.digest();
};

export const readOpfsSha256 = (page: Page, fileName: string): Promise<string> =>
  page.evaluate(hashOpfsFileInPage, fileName);
