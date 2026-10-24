// Local-only HTTP, BitTorrent and BEP 9 metadata fixtures for NAS acceptance.

import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

const data = Buffer.alloc(8 * 1024 * 1024)
for (let i = 0; i < data.length; i++) data[i] = i % 256
const btData = data.subarray(0, 131072)
const hash = (algorithm, value) => createHash(algorithm).update(value).digest()
function encode(value) {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string') value = Buffer.from(value)
  if (Buffer.isBuffer(value))
    return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (Array.isArray(value))
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(encode),
      Buffer.from('e'),
    ])
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [encode(key), encode(value[key])]),
    Buffer.from('e'),
  ])
}
function decode(buffer, start = 0) {
  let offset = start
  function next() {
    const kind = buffer[offset]
    if (kind === 105) {
      const end = buffer.indexOf(101, ++offset)
      const value = Number(buffer.subarray(offset, end))
      offset = end + 1
      return value
    }
    if (kind === 100 || kind === 108) {
      offset++
      const value = kind === 100 ? {} : []
      while (buffer[offset] !== 101) {
        const key = next()
        if (kind === 100) value[key.toString()] = next()
        else value.push(key)
      }
      offset++
      return value
    }
    const colon = buffer.indexOf(58, offset)
    const size = Number(buffer.subarray(offset, colon))
    offset = colon + 1
    const value = buffer.subarray(offset, offset + size)
    offset += size
    return value
  }
  return next()
}
const pieces = []
for (let i = 0; i < btData.length; i += 16384)
  pieces.push(hash('sha1', btData.subarray(i, i + 16384)))
const info = encode({
  length: btData.length,
  name: 'bt-native.bin',
  'piece length': 16384,
  pieces: Buffer.concat(pieces),
})
const infoHash = hash('sha1', info)
const torrent = encode({
  announce: 'http://127.0.0.1:18765/announce',
  info: decode(info),
})
const magnet = `magnet:?xt=urn:btih:${infoHash.toString('hex')}&dn=bt-native.bin&tr=${encodeURIComponent('http://127.0.0.1:18765/announce')}`
const description = {
  torrent: torrent.toString('base64'),
  magnet,
  infoHash: infoHash.toString('hex'),
  httpSha256: hash('sha256', data.subarray(0, 262144)).toString('hex'),
  resumeSha256: hash('sha256', data).toString('hex'),
  btSha256: hash('sha256', btData).toString('hex'),
}
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/fixture.json') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(description))
    return
  }
  if (url.pathname === '/announce') {
    const peer = Buffer.from([127, 0, 0, 1, 18766 >> 8, 18766 & 255])
    response.end(
      encode({ interval: 5, complete: 1, incomplete: 0, peers: peer })
    )
    return
  }
  if (url.pathname === '/fixture.torrent') {
    response.end(torrent)
    return
  }
  if (!['/http.bin', '/resume.bin'].includes(url.pathname)) {
    response.writeHead(404).end()
    return
  }
  const body = url.pathname === '/http.bin' ? data.subarray(0, 262144) : data
  let start = 0,
    end = body.length - 1
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
  if (range) {
    start = Number(range[1])
    if (range[2]) end = Number(range[2])
  }
  if (start > end || end >= body.length) {
    response.writeHead(416).end()
    return
  }
  response.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ETag: '"motrix-native-v1"',
    ...(range
      ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` }
      : {}),
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  if (url.pathname === '/http.bin') {
    response.end(body.subarray(start, end + 1))
    return
  }
  let offset = start
  const timer = setInterval(() => {
    const next = Math.min(offset + 65536, end + 1)
    response.write(body.subarray(offset, next))
    offset = next
    if (offset > end) {
      clearInterval(timer)
      response.end()
    }
  }, 250)
  response.once('close', () => clearInterval(timer))
})
server.listen(18765, '127.0.0.1')
const peers = net.createServer((socket) => {
  let input = Buffer.alloc(0),
    handshaken = false,
    metadataId = 1
  const send = (body) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    socket.write(Buffer.concat([length, body]))
  }
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    input = Buffer.concat([input, chunk])
    if (!handshaken) {
      if (input.length < 68) return
      if (!input.subarray(28, 48).equals(infoHash)) {
        socket.destroy()
        return
      }
      const reserved = Buffer.alloc(8)
      reserved[5] = 0x10
      socket.write(
        Buffer.concat([
          Buffer.from([19]),
          Buffer.from('BitTorrent protocol'),
          reserved,
          infoHash,
          Buffer.from('-MQ0001-123456789012'),
        ])
      )
      input = input.subarray(68)
      handshaken = true
      send(Buffer.from([5, 255]))
      send(Buffer.from([1]))
      send(
        Buffer.concat([
          Buffer.from([20, 0]),
          encode({ m: { ut_metadata: 1 }, metadata_size: info.length }),
        ])
      )
    }
    while (input.length >= 4) {
      const length = input.readUInt32BE(0)
      if (length > 1048576) {
        socket.destroy()
        return
      }
      if (input.length < length + 4) break
      const body = input.subarray(4, length + 4)
      input = input.subarray(length + 4)
      if (body[0] === 6 && body.length === 13) {
        const index = body.readUInt32BE(1),
          begin = body.readUInt32BE(5),
          size = body.readUInt32BE(9)
        const offset = index * 16384 + begin
        if (size > 16384 || offset + size > btData.length) {
          socket.destroy()
          return
        }
        send(
          Buffer.concat([
            Buffer.from([7]),
            body.subarray(1, 9),
            btData.subarray(offset, offset + size),
          ])
        )
      }
      if (body[0] === 20) {
        try {
          const message = decode(body.subarray(2))
          if (body[1] === 0) metadataId = message.m?.ut_metadata ?? 1
          if (body[1] === 1 && message.msg_type === 0) {
            const start = message.piece * 16384
            send(
              Buffer.concat([
                Buffer.from([20, metadataId]),
                encode({
                  msg_type: 1,
                  piece: message.piece,
                  total_size: info.length,
                }),
                info.subarray(start, start + 16384),
              ])
            )
          }
        } catch {
          socket.destroy()
        }
      }
    }
  })
})
peers.listen(18766, '127.0.0.1')
console.log(
  JSON.stringify({
    ready: true,
    httpPort: 18765,
    peerPort: 18766,
    ...description,
  })
)
