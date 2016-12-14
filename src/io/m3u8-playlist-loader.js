/*
 *  @filename m3u8-playlist-this.js
 */

import Log from '../utils/logger';
import m3u8 from 'm3u8-parser';
import EventEmitter from 'events';
import resolveURL from '../utils/resolve-url';

/**
 * Returns a new array of segments that is the result of merging
 * properties from an older list of segments onto an updated
 * list. No properties on the updated playlist will be overridden.
 *
 * @param {Array} original the outdated list of segments
 * @param {Array} update the updated list of segments
 * @param {Number=} offset the index of the first update
 * segment in the original segment list. For non-live playlists,
 * this should always be zero and does not need to be
 * specified. For live playlists, it should be the difference
 * between the media sequence numbers in the original and updated
 * playlists.
 * @return a list of merged segment objects
 */
const updateSegments = function (original, update, offset) {
    let result = update.slice();
    let length;
    let i;

    offset = offset || 0;
    length = Math.min(original.length, update.length + offset);

    for (i = offset; i < length; i++) {
        result[i - offset] = Object.assign(original[i], result[i - offset]);
    }
    return result;
};

/**
 * Returns a new master playlist that is the result of merging an
 * updated media playlist into the original version. If the
 * updated media playlist does not match any of the playlist
 * entries in the original master playlist, null is returned.
 *
 * @param {Object} master a parsed master M3U8 object
 * @param {Object} media a parsed media M3U8 object
 * @return {Object} a new object that represents the original
 * master playlist with the updated media playlist merged in, or
 * null if the merge produced no change.
 */
const updateMaster = function (master, media) {
    let changed = false;
    let result = Object.assign(master, {});
    let i = master.playlists.length;
    let playlist;
    let segment;
    let j;

    while (i--) {
        playlist = result.playlists[i];
        if (playlist.uri === media.uri) {
            // consider the playlist unchanged if the number of segments
            // are equal and the media sequence number is unchanged
            if (playlist.segments &&
                media.segments &&
                playlist.segments.length === media.segments.length &&
                playlist.mediaSequence === media.mediaSequence) {
                continue;
            }

            result.playlists[i] = Object.assign(playlist, media);
            result.playlists[media.uri] = result.playlists[i];

            // if the update could overlap existing segment information,
            // merge the two lists
            if (playlist.segments) {
                result.playlists[i].segments = updateSegments(
                    playlist.segments,
                    media.segments,
                    media.mediaSequence - playlist.mediaSequence
                );
            }
            // resolve any missing segment and key URIs
            j = 0;
            if (result.playlists[i].segments) {
                j = result.playlists[i].segments.length;
            }
            while (j--) {
                segment = result.playlists[i].segments[j];
                if (!segment.resolvedUri) {
                    segment.resolvedUri = resolveURL(playlist.resolvedUri, segment.uri);
                }
                if (segment.key && !segment.key.resolvedUri) {
                    segment.key.resolvedUri = resolveURL(playlist.resolvedUri, segment.key.uri);
                }
                if (segment.map && !segment.map.resolvedUri) {
                    segment.map.resolvedUri = resolveURL(playlist.resolvedUri, segment.map.uri);
                }
            }
            changed = true;
        }
    }
    return changed ? result : null;
};

class M3U8PlaylistLoader {

    constructor(srcURL, withCredentials) {
        this.TAG = 'M3U8PlaylistLoader';
        this.state = 'HAVE_NOTHING';
        this.url = srcURL;
        this.withCredentials = withCredentials;
        this.cors = true;
        this.bandwidth = null;
        this.started = false;
        this._media = null;
        this.update = null;
        this._xhr = null;
        this.refreshDelay = null;
        this.mediaUpdateTimeout = null;
        this.withCredentials = withCredentials;

        // track the time that has expired from the live window
        // this allows the seekable start range to be calculated even if
        // all segments with timing information have expired
        this.expired_ = 0;


        this._emitter = new EventEmitter();
        if (!srcURL) {
            Log.e(this.TAG, 'A non-empty playlist URL is required');
        }

        resolveURL();
    }

    destroy() {
        this.stopRequest();
        window.clearTimeout(this.mediaUpdateTimeout);

    }

    /**
     * Returns the number of enabled playlists on the master playlist object
     *
     * @return {Number} number of eneabled playlists
     */
    enabledPlaylists() {
        return this.master.playlists.filter((element) => {
            return !element.excludeUntil || element.excludeUntil <= Date.now();
        }).length;
    }

    haveMetadata(xhr, url) {
        const parser = new m3u8.Parser();

        this.setBandwidth(xhr);
        this.state = 'HAVE_METADATA';
        parser.push(xhr.responseText);
        parser.end();
        parser.mainfest.uri = url;

        // merge this playlist into the master
        let update = updateMaster(this.master, parser.manifest);
        this.refreshDelay = (parser.manifest.targetDuration || 10) * 1000;
        this.targetDuration = parser.manifest.targetDuration;

        if (update) {
            this.master = update;
            this.updateMediaPlaylist_(parser.manifest);
        } else {
            // if the playlist is unchanged since the last reload,
            // try again after half the target duration
            this.refreshDelay /= 2;
        }

        // refresh live playlists after a target duration passes
        if (!this.media().endList) {
            window.clearTimeout(this.mediaUpdateTimeout);
            this.mediaUpdateTimeout = window.setTimeout(function () {
                // this.trigger('mediaupdatetimeout');
            }, this.refreshDelay);
        }


    }

    /**
     * Returns whether the current playlist is the lowest rendition
     *
     * @return {Boolean} true if on lowest rendition
     */
    isLowestEnabledRendition_() {
        let media = this.media();

        if (!media || !media.attributes) {
            return false;
        }

        let currentBandwidth = this.media().attributes.BANDWIDTH || 0;

        return !(this.master.playlists.filter((playlist) => {
            let enabled = typeof playlist.excludeUntil === 'undefined' ||
                playlist.excludeUntil <= Date.now();

            if (!enabled) {
                return false;
            }

            let bandwidth = 0;

            if (playlist && playlist.attributes) {
                bandwidth = playlist.attributes.BANDWIDTH;
            }
            return bandwidth <= currentBandwidth;

        }).length > 1);
    }

    pause() {
        this.stopRequest();
        window.clearTimeout(this.mediaUpdateTimeout);
    }

    load() {
        if (this.started) {
            // do sth
        } else {
            this.start();
        }
    }

    setBandwidth(xhr) {
        this.bandwidth = xhr.bandwidth;
    }

    start() {
        this.started = true;
        this._xhr = self.fetch(this.srcURL, {
            withCredentials: this.withCredentials
        }).then((res) => res.text()).then((text) => {
            let parser = new m3u8.Parser();
            parser.push(text);
            parser.end();

            this.state = 'HAVE_MASTER';
            
            parser.mainfest.uri = this.srcURL; 
            
            // loaded a master playlist
            if (parser.mainfest.playlists) {
                this.master = parser.mainfest;

                // setup by-URI lookups and resolve media playlist URIs
                i = this.master.playlists.length;
                while (i--) {
                    playlist = this.master.playlists[i];
                    this.master.playlists[playlist.uri] = playlist;
                    playlist.resolvedUri = resolveURL(this.master.uri, playlist.uri);
                }

                // resolve any media group URIs
                for (let groupKey in loader.master.mediaGroups.AUDIO) {
                    for (let labelKey in loader.master.mediaGroups.AUDIO[groupKey]) {
                        let alternateAudio = loader.master.mediaGroups.AUDIO[groupKey][labelKey];

                        if (alternateAudio.uri) {
                            alternateAudio.resolvedUri =
                                resolveURL(loader.master.uri, alternateAudio.uri);
                        }
                    }
                }
                
                
            }
        }).catch((e) => {

        })
    }

    stopRequest() {
        if (this._xhr) {
            let oldXhr = this._xhr;

            this._xhr = null;
            oldXhr.onreadystatechange = null;
            oldXhr.abort();
        }
    }

    updateMediaPlaylist_(update) {
        let outdated;
        let i;
        let segment;

        outdated = this._media;
        this._media = this.master.playlists[update.uri];

        if (!outdated) {
            return;
        }

        // don't track expired time until this flag is truthy
        if (!this.trackExpiredTime_) {
            return;
        }

        // if the update was the result of a rendition switch do not
        // attempt to calculate expired_ since media-sequences need not
        // correlate between renditions/variants
        if (update.uri !== outdated.uri) {
            return;
        }

        // try using precise timing from first segment of the updated
        // playlist
        if (update.segments.length) {
            if (typeof update.segments[0].start !== 'undefined') {
                this.expired_ = update.segments[0].start;
                return;
            } else if (typeof update.segments[0].end !== 'undefined') {
                this.expired_ = update.segments[0].end - update.segments[0].duration;
                return;
            }
        }

        // calculate expired by walking the outdated playlist
        i = update.mediaSequence - outdated.mediaSequence - 1;

        for (; i >= 0; i--) {
            segment = outdated.segments[i];

            if (!segment) {
                // we missed information on this segment completely between
                // playlist updates so we'll have to take an educated guess
                // once we begin buffering again, any error we introduce can
                // be corrected
                this.expired_ += outdated.targetDuration || 10;
                continue;
            }

            if (typeof segment.end !== 'undefined') {
                this.expired_ = segment.end;
                return;
            }
            if (typeof segment.start !== 'undefined') {
                this.expired_ = segment.start + segment.duration;
                return;
            }
            this.expired_ += segment.duration;
        }
    }

    onPlaylistRequestError(xhr, url, startingState) {
        this.setBandwidth(this._xhr || xhr);

        // any in-flight request is now finished
        this._xhr = null;

        if (startingState) {
            this.state = startingState;
        }

        this.error = {
            playlist: this.master.playlists[url],
            status: xhr.status,
            message: 'HLS playlist request error at URL: ' + url,
            responseText: xhr.responseText,
            code: (xhr.status >= 500) ? 4 : 2
        };

    }

    media(playlist) {
        let startingState = this.state;
        let mediaChange;

        // getter
        if (!playlist) {
            return this._media;
        }

        // setter
        if (this.state === 'HAVE_NOTHING') {
            Log.e(this.TAG, 'Cannot switch media playlist from ' + this.state);
        }

        // find the playlist object if the target playlist has been
        // specified by URI
        if (typeof playlist === 'string') {
            if (!this.master.playlists[playlist]) {
                Log.e(this.TAG, 'Unknown playlist URI: ' + playlist);
            }
            playlist = this.master.playlists[playlist];
        }

        mediaChange = !this._media || playlist.uri !== this._media.uri;

        // switch to fully loaded playlists immediately
        if (this.master.playlists[playlist.uri].endList) {
            // abort outstanding playlist requests
            if (this._xhr) {
                this._xhr.onreadystatechange = null;
                this._xhr.abort();
                this._xhr = null;
            }
            this.state = 'HAVE_METADATA';
            this._media = playlist;

            // trigger media change if the active media has been updated
            if (mediaChange) {
                this.trigger('mediachanging');
                this.trigger('mediachange');
            }
            return;
        }

        // switching to the active playlist is a no-op
        if (!mediaChange) {
            return;
        }

        this.state = 'SWITCHING_MEDIA';

        // there is already an outstanding playlist request
        if (this._xhr) {
            if (resolveURL(this.master.uri, playlist.uri) === this._xhr.url) {
                // requesting to switch to the same playlist multiple times
                // has no effect after the first
                return;
            }
            this._xhr.onreadystatechange = null;
            this._xhr.abort();
            this._xhr = null;
        }

        // request the new playlist
        if (this._media) {
            this.trigger('mediachanging');
        }
        this._xhr = this.hls_.xhr({
            uri: resolveURL(this.master.uri, playlist.uri),
            withCredentials: this.withCredentials
        }, function (error, req) {
            // disposed
            if (!this._xhr) {
                return;
            }

            if (error) {
                return this.onPlaylistRequestError(this._xhr, playlist.uri, startingState);
            }

            this.haveMetadata(req, playlist.uri);

            // fire loadedmetadata the first time a media playlist is loaded
            if (startingState === 'HAVE_MASTER') {
                this.trigger('loadedmetadata');
            } else {
                this.trigger('mediachange');
            }
        });
    }

}

export default M3U8PlaylistLoader;