import fs from 'node:fs'
import path from 'node:path'

const root = fs.realpathSync(process.argv[2])
const interpreter = path.join(root, 'runtime/lib/ld-musl-x86_64.so.1')
const binaries = [
  'runtime/bin/node',
  'server/bin/aria2c',
  'server/bin/motrix-finalize-fs',
]
for (const relative of binaries) {
  const file = path.join(root, relative)
  const data = fs.readFileSync(file)
  if (
    data.readUInt32BE(0) !== 0x7f454c46 ||
    data[4] !== 2 ||
    data[5] !== 1 ||
    data.readUInt16LE(18) !== 62
  ) {
    throw new Error(`Expected an x86_64 ELF file: ${relative}`)
  }
  const programOffset = Number(data.readBigUInt64LE(32))
  const entrySize = data.readUInt16LE(54)
  const count = data.readUInt16LE(56)
  for (let i = 0; i < count; i++) {
    const header = programOffset + i * entrySize
    if (data.readUInt32LE(header) !== 3) continue
    const offset = Number(data.readBigUInt64LE(header + 8))
    const capacity = Number(data.readBigUInt64LE(header + 32))
    const value = Buffer.from(`${interpreter}\0`)
    if (value.length > capacity || offset + capacity > data.length) {
      throw new Error(`Interpreter reservation is too small: ${relative}`)
    }
    if (data.subarray(offset, offset + value.length).equals(value)) break
    // Write only the reserved interpreter field; preserve executable mode and inode.
    const field = Buffer.alloc(capacity)
    value.copy(field)
    const descriptor = fs.openSync(file, 'r+')
    try {
      fs.writeSync(descriptor, field, 0, field.length, offset)
    } finally {
      fs.closeSync(descriptor)
    }
    console.log(`Relocated ${relative}`)
    break
  }
}
