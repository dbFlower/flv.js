/**
 * ID3 parser
 * @filename ID3 parser
 * eslint no-constant-condition: ["error", { "checkLoops": false }]
 */
import Log from '../utils/logger';

class ID3 {

    constructor(data) {
        this._hasTimeStamp = false;
        let offset = 0, byte1, byte2, byte3, byte4, tagSize, endPos, header, len;
        /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
        do {
            header = this.readUTF(data, offset, 3);
            offset += 3;
            // first check for ID3 header
            if (header === 'ID3') {
                // skip 24 bits
                offset += 3;
                // retrieve tag(s) length
                byte1 = data[offset++] & 0x7f;
                byte2 = data[offset++] & 0x7f;
                byte3 = data[offset++] & 0x7f;
                byte4 = data[offset++] & 0x7f;
                tagSize = (byte1 << 21) + (byte2 << 14) + (byte3 << 7) + byte4;
                endPos = offset + tagSize;
                //Log.v(this.TAG, `ID3 tag found, size/end: ${tagSize}/${endPos}`);

                // read ID3 tags
                this._parseID3Frames(data, offset, endPos);
                offset = endPos;
            } else if (header === '3DI') {
                // http://id3.org/id3v2.4.0-structure chapter 3.4.   ID3v2 footer
                offset += 7;
                Log.v(this.TAG, `3DI footer found, end: ${offset}`);
            } else {
                offset -= 3;
                len = offset;
                if (len) {
                    //Log.v(this.TAG, `ID3 len: ${len}`);
                    if (!this.hasTimeStamp) {
                        Log.w(this.TAG, 'ID3 tag found, but no timestamp');
                    }
                    this._length = len;
                    this._payload = data.subarray(0, len);
                }
                return;
            }
        } while (true);
    }

    readUTF(data, start, len) {
        let result = '', offset = start, end = start + len;
        do {
            result += String.fromCharCode(data[offset++]);
        } while (offset < end);
        return result;
    }

    _parseID3Frames(data, offset, endPos) {
        let tagId, tagLen, tagStart, tagFlags, timestamp;
        while (offset + 8 <= endPos) {
            tagId = this.readUTF(data, offset, 4);
            offset += 4;

            tagLen = data[offset++] << 24 +
                data[offset++] << 16 +
                data[offset++] << 8 +
                data[offset++];

            tagFlags = data[offset++] << 8 +
                data[offset++];

            tagStart = offset;
            //Log.v(this.TAG, "ID3 tag id:" + tagId);
            switch (tagId) {
                case 'PRIV':
                    //Log.v(this.TAG, 'parse frame:' + Hex.hexDump(data.subarray(offset,endPos)));
                    // owner should be "com.apple.streaming.transportStreamTimestamp"
                    if (this.readUTF(data, offset, 44) === 'com.apple.streaming.transportStreamTimestamp') {
                        offset += 44;
                        // smelling even better ! we found the right descriptor
                        // skip null character (string end) + 3 first bytes
                        offset += 4;

                        // timestamp is 33 bit expressed as a big-endian eight-octet number, with the upper 31 bits set to zero.
                        let pts33Bit = data[offset++] & 0x1;
                        this._hasTimeStamp = true;

                        timestamp = ((data[offset++] << 23) +
                            (data[offset++] << 15) +
                            (data[offset++] << 7) +
                            data[offset++]) / 45;

                        if (pts33Bit) {
                            timestamp += 47721858.84; // 2^32 / 90
                        }
                        timestamp = Math.round(timestamp);
                        Log.d(this.TAG, `ID3 timestamp found: ${timestamp}`);
                        this._timeStamp = timestamp;
                    }
                    break;
                default:
                    break;
            }
        }
    }

    get hasTimeStamp() {
        return this._hasTimeStamp;
    }

    get timeStamp() {
        return this._timeStamp;
    }

    get length() {
        return this._length;
    }

    get payload() {
        return this._payload;
    }

}

export default ID3;

