/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {IllegalStateException, InvalidArgumentException} from '../utils/exception.js';

// Exponential-Golomb buffer decoder
class ExpGolomb {

    constructor(uint8array) {
        this.TAG = 'ExpGolomb';

        this._buffer = uint8array;
        this._buffer_index = 0;
        this._total_bytes = uint8array.byteLength;
        this._total_bits = uint8array.byteLength * 8;
        this._current_word = 0;
        this._current_word_bits_left = 0;
    }

    destroy() {
        this._buffer = null;
    }

    _fillCurrentWord() {
        let buffer_bytes_left = this._total_bytes - this._buffer_index;
        if (buffer_bytes_left <= 0)
            throw new IllegalStateException('ExpGolomb: _fillCurrentWord() but no bytes available');

        let bytes_read = Math.min(4, buffer_bytes_left);
        let word = new Uint8Array(4);
        word.set(this._buffer.subarray(this._buffer_index, this._buffer_index + bytes_read));
        this._current_word = new DataView(word.buffer).getUint32(0, false);

        this._buffer_index += bytes_read;
        this._current_word_bits_left = bytes_read * 8;
    }

    // (count:int):void
    skipBits(count) {
        let skipBytes; // :int
        if (this._current_word_bits_left > count) {
            this._current_word <<= count;
            this._current_word_bits_left -= count;
        } else {
            count -= this._current_word_bits_left;
            skipBytes = count >> 3;
            count -= (skipBytes >> 3);
            this._buffer_index += skipBytes;
            this._fillCurrentWord();
            this._current_word <<= count;
            this._current_word_bits_left -= count;
        }
    }

    // ():void
    skipUEG() {
        this.skipBits(1 + this._skipLeadingZero());
    }

    // ():void
    skipEG() {
        this.skipBits(1 + this._skipLeadingZero());
    }

    // ():int
    readEG() {
        let valu = this.readUEG(); // :int
        if (0x01 & valu) {
            // the number is odd if the low order bit is set
            return (1 + valu) >>> 1; // add 1 to make it even, and divide by 2
        } else {
            return -1 * (valu >>> 1); // divide by two then make it negative
        }
    }

    readBits(bits) {
        if (bits > 32)
            throw new InvalidArgumentException('ExpGolomb: readBits() bits exceeded max 32bits!');

        if (bits <= this._current_word_bits_left) {
            let result = this._current_word >>> (32 - bits);
            this._current_word <<= bits;
            this._current_word_bits_left -= bits;
            return result;
        }

        let result = this._current_word_bits_left ? this._current_word : 0;
        result = result >>> (32 - this._current_word_bits_left);
        let bits_need_left = bits - this._current_word_bits_left;

        this._fillCurrentWord();
        let bits_read_next = Math.min(bits_need_left, this._current_word_bits_left);

        let result2 = this._current_word >>> (32 - bits_read_next);
        this._current_word <<= bits_read_next;
        this._current_word_bits_left -= bits_read_next;

        result = (result << bits_read_next) | result2;
        return result;
    }

    readBool() {
        return this.readBits(1) === 1;
    }

    readByte() {
        return this.readBits(8);
    }

    readShort() {
        return this.readBits(16);
    }

    readInt() {
        return this.readBits(32);
    }

    _skipLeadingZero() {
        let zero_count;
        for (zero_count = 0; zero_count < this._current_word_bits_left; zero_count++) {
            if (0 !== (this._current_word & (0x80000000 >>> zero_count))) {
                this._current_word <<= zero_count;
                this._current_word_bits_left -= zero_count;
                return zero_count;
            }
        }
        this._fillCurrentWord();
        return zero_count + this._skipLeadingZero();
    }

    readUEG() {  // unsigned exponential golomb
        let leading_zeros = this._skipLeadingZero();
        return this.readBits(leading_zeros + 1) - 1;
    }

    readSEG() {  // signed exponential golomb
        let value = this.readUEG();
        if (value & 0x01) {
            return (value + 1) >>> 1;
        } else {
            return -1 * (value >>> 1);
        }
    }

    /**
     * Advance the ExpGolomb decoder past a scaling list. The scaling
     * list is optionally transmitted as part of a sequence parameter
     * set and is not relevant to transmuxing.
     * @param count {number} the number of entries in this scaling list
     * @see Recommendation ITU-T H.264, Section 7.3.2.1.1.1
     */
    skipScalingList(count) {
        let
            lastScale = 8,
            nextScale = 8,
            j,
            deltaScale;
        for (j = 0; j < count; j++) {
            if (nextScale !== 0) {
                deltaScale = this.readEG();
                nextScale = (lastScale + deltaScale + 256) % 256;
            }
            lastScale = (nextScale === 0) ? lastScale : nextScale;
        }
    }

    /**
     * Read a sequence parameter set and return some interesting video
     * properties. A sequence parameter set is the H264 metadata that
     * describes the properties of upcoming video frames.
     * @param data {Uint8Array} the bytes of a sequence parameter set
     * @return {object} an object with configuration parsed from the
     * sequence parameter set, including the dimensions of the
     * associated video frames.
     */
    readSPS() {
        let
            frameCropLeftOffset = 0,
            frameCropRightOffset = 0,
            frameCropTopOffset = 0,
            frameCropBottomOffset = 0,
            sarScale = 1,
            profileIdc, profileCompat, levelIdc,
            numRefFramesInPicOrderCntCycle, picWidthInMbsMinus1,
            picHeightInMapUnitsMinus1,
            frameMbsOnlyFlag,
            scalingListCount,
            i;
        this.readByte();
        profileIdc = this.readByte(); // profile_idc
        profileCompat = this.readBits(5); // constraint_set[0-4]_flag, u(5)
        this.skipBits(3); // reserved_zero_3bits u(3),
        levelIdc = this.readByte(); //level_idc u(8)
        this.skipUEG(); // seq_parameter_set_id
        // some profiles have more optional data we don't need
        if (profileIdc === 100 ||
            profileIdc === 110 ||
            profileIdc === 122 ||
            profileIdc === 244 ||
            profileIdc === 44 ||
            profileIdc === 83 ||
            profileIdc === 86 ||
            profileIdc === 118 ||
            profileIdc === 128) {
            let chromaFormatIdc = this.readUEG();
            if (chromaFormatIdc === 3) {
                this.skipBits(1); // separate_colour_plane_flag
            }
            this.skipUEG(); // bit_depth_luma_minus8
            this.skipUEG(); // bit_depth_chroma_minus8
            this.skipBits(1); // qpprime_y_zero_transform_bypass_flag
            if (this.readBool()) { // seq_scaling_matrix_present_flag
                scalingListCount = (chromaFormatIdc !== 3) ? 8 : 12;
                for (i = 0; i < scalingListCount; i++) {
                    if (this.readBool()) { // seq_scaling_list_present_flag[ i ]
                        if (i < 6) {
                            this.skipScalingList(16);
                        } else {
                            this.skipScalingList(64);
                        }
                    }
                }
            }
        }
        this.skipUEG(); // log2_max_frame_num_minus4
        let picOrderCntType = this.readUEG();
        if (picOrderCntType === 0) {
            this.readUEG(); //log2_max_pic_order_cnt_lsb_minus4
        } else if (picOrderCntType === 1) {
            this.skipBits(1); // delta_pic_order_always_zero_flag
            this.skipEG(); // offset_for_non_ref_pic
            this.skipEG(); // offset_for_top_to_bottom_field
            numRefFramesInPicOrderCntCycle = this.readUEG();
            for (i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
                this.skipEG(); // offset_for_ref_frame[ i ]
            }
        }
        this.skipUEG(); // max_num_ref_frames
        this.skipBits(1); // gaps_in_frame_num_value_allowed_flag
        picWidthInMbsMinus1 = this.readUEG();
        picHeightInMapUnitsMinus1 = this.readUEG();
        frameMbsOnlyFlag = this.readBits(1);
        if (frameMbsOnlyFlag === 0) {
            this.skipBits(1); // mb_adaptive_frame_field_flag
        }
        this.skipBits(1); // direct_8x8_inference_flag
        if (this.readBool()) { // frame_cropping_flag
            frameCropLeftOffset = this.readUEG();
            frameCropRightOffset = this.readUEG();
            frameCropTopOffset = this.readUEG();
            frameCropBottomOffset = this.readUEG();
        }
        if (this.readBool()) {
            // vui_parameters_present_flag
            if (this.readBool()) {
                // aspect_ratio_info_present_flag
                let sarRatio;
                const aspectRatioIdc = this.readByte();
                switch (aspectRatioIdc) {
                    case 1:
                        sarRatio = [1, 1];
                        break;
                    case 2:
                        sarRatio = [12, 11];
                        break;
                    case 3:
                        sarRatio = [10, 11];
                        break;
                    case 4:
                        sarRatio = [16, 11];
                        break;
                    case 5:
                        sarRatio = [40, 33];
                        break;
                    case 6:
                        sarRatio = [24, 11];
                        break;
                    case 7:
                        sarRatio = [20, 11];
                        break;
                    case 8:
                        sarRatio = [32, 11];
                        break;
                    case 9:
                        sarRatio = [80, 33];
                        break;
                    case 10:
                        sarRatio = [18, 11];
                        break;
                    case 11:
                        sarRatio = [15, 11];
                        break;
                    case 12:
                        sarRatio = [64, 33];
                        break;
                    case 13:
                        sarRatio = [160, 99];
                        break;
                    case 14:
                        sarRatio = [4, 3];
                        break;
                    case 15:
                        sarRatio = [3, 2];
                        break;
                    case 16:
                        sarRatio = [2, 1];
                        break;
                    case 255: {
                        sarRatio = [this.readByte() << 8 | this.readByte(), this.readByte() << 8 | this.readByte()];
                        break;
                    }
                }
                if (sarRatio) {
                    sarScale = sarRatio[0] / sarRatio[1];
                }
            }
        }
        return {
            width: Math.ceil((((picWidthInMbsMinus1 + 1) * 16) - frameCropLeftOffset * 2 - frameCropRightOffset * 2) * sarScale),
            height: ((2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16) - ((frameMbsOnlyFlag ? 2 : 4) * (frameCropTopOffset + frameCropBottomOffset))
        };
    }
}

export default ExpGolomb;