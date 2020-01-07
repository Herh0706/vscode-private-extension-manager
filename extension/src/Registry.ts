import * as fs from 'fs';
import * as t from 'io-ts';
import * as npmsearch from 'libnpmsearch';
import { Options } from 'libnpmsearch';
import * as npa from 'npm-package-arg';
import * as npmfetch from 'npm-registry-fetch';
import * as pacote from 'pacote';
import * as path from 'path';
import sanitize = require('sanitize-filename');
import { SemVer } from 'semver';
import { CancellationToken, Uri, window } from 'vscode';
import * as nls from 'vscode-nls';

import { NotAnExtensionError, Package } from './Package';
import { assertType, options } from './typeUtil';
import { getConfig, getNpmCacheDir, getNpmDownloadDir, uriEquals } from './util';

const localize = nls.loadMessageBundle();

/** Maximum number of search results per request. */
const QUERY_LIMIT = 100;

export enum RegistrySource {
    /** Registry is defined by user settings. */
    User = 'user',
    /** Registry is defined by a workspace folder's extensions.private.json. */
    Workspace = 'workspace',
}

/**
 * Error thrown when trying to get a version of a package that does not exist.
 */
export class VersionMissingError extends Error {
    constructor(public pkg: string, public version: string) {
        super(localize('version.missing', 'Couldn\'t find version "{0}" for package "{1}".', version, pkg));
    }
}

export interface RegistryOptions {
    /**
     * URL of the NPM registry to use. If omitted, this uses NPM's normal
     * resolution scheme (searches .npmrc, user config, etc.).
     */
    registry: string;

    /**
     * If set, only return packages that match this query.
     *
     * Use this when your registry contains more packages than just VS Code
     * extensions to filter to just the packages that are extensions, or when
     * it contains multiple groups of extensions and you only want to display
     * some of them.
     *
     * See https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md#get-v1search
     * for special search qualifiers such as `keywords:`.
     */
    query: string | string[];
}

export interface VersionInfo {
    version: SemVer;
    time?: Date;
}

const PackageVersionData = options(
    {
        'dist-tags': t.record(t.string, t.string),
        versions: t.record(t.string, t.record(t.string, t.any)),
    },
    {
        time: t.record(t.string, t.string),
    },
);
type PackageVersionData = t.TypeOf<typeof PackageVersionData>;

/**
 * Represents an NPM registry.
 */
export class Registry {
    /**
     * Comparison function to sort registries by name in alphabetical order.
     */
    public static compare(a: Registry, b: Registry) {
        const nameA = a.name.toUpperCase();
        const nameB = b.name.toUpperCase();

        return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    }

    public readonly query: string | string[];

    public readonly options: Partial<Options>;

    constructor(
        public readonly name: string,
        public readonly source: RegistrySource,
        options: Partial<RegistryOptions & Options>,
    ) {
        const { query, ...searchOpts } = options;

        // '*' seems to work as a "get all packages" wildcard. If we just
        // leave the search text blank, it will return nothing.
        this.query = query ?? '*';
        this.options = searchOpts;

        this.options.cache = getNpmCacheDir();
    }

    /**
     * The Uri of the registry, if configured. If this is `undefined`, NPM's
     * normal resolution scheme is used to find the registry.
     */
    public get uri() {
        return this.options.registry ? Uri.parse(this.options.registry) : undefined;
    }

    /**
     * Gets whether this registry has the same Uri and filtering options as
     * another registry.
     */
    public equals(other: Registry) {
        if (!queryEquals(this.query, other.query)) {
            return false;
        }

        if (this.uri && other.uri) {
            return uriEquals(this.uri, other.uri);
        } else {
            return this.uri === undefined && other.uri === undefined;
        }
    }

    /**
     * Download a package and return the Uri of the directory where it was
     * extracted.
     *
     * @param packageOrSpec A package to download, or an NPM package specifier.
     */
    public async downloadPackage(packageOrSpec: Package | string) {
        const spec = packageOrSpec instanceof Package ? packageOrSpec.spec : packageOrSpec;

        const registryDir = sanitize(this.options.registry ?? this.name);
        const dest = path.join(getNpmDownloadDir(), registryDir, spec);

        // If we've already downloaded this package, just return it.
        if (!fs.existsSync(dest)) {
            await pacote.extract(spec, dest, this.options);
        }

        return Uri.file(dest);
    }

    /**
     * Gets all packages matching the registry options.
     *
     * @param token Token to use to cancel the search.
     */
    public async getPackages(token?: CancellationToken): Promise<Package[]> {
        const packages: Package[] = [];

        for await (const result of this.findMatchingPackages(this.query, token)) {
            if (token?.isCancellationRequested) {
                break;
            }

            try {
                const pkg = await this.getPackageVersionMetadata(result.name);
                packages.push(pkg);
            } catch (ex) {
                if (ex instanceof NotAnExtensionError) {
                    // Package is not an extension. Ignore.
                } else if (ex instanceof VersionMissingError) {
                    // Requested package version does not exist
                    const openSettingsJson = localize('open.settings.json', 'Open settings.json');
                    const settingsJsonLink = `[${openSettingsJson}](command:workbench.action.openSettingsJson)`;

                    // TODO: Add a quick link to reset to 'latest' via command
                    window.showErrorMessage(
                        localize(
                            'invalid.channel',
                            '{0} Your "privateExtensions.channels" setting may be invalid.  {1} to fix.',
                            ex.message,
                            settingsJsonLink,
                        ),
                    );
                } else {
                    console.warn(`Discarding package ${result.name}:`, ex);
                }
            }
        }

        await Promise.all(packages.map(pkg => pkg.updateState()));

        return packages;
    }

    /**
     * Gets the full package metadata for a package.
     */
    public async getPackageMetadata(name: string) {
        const spec = npa(name);
        return await npmfetch.json(`/${spec.escapedName}`, this.options);
    }

    /**
     * Gets the list of available versions for a package.
     */
    public async getPackageVersions(name: string): Promise<VersionInfo[]> {
        const metadata = await this.getPackageMetadata(name);

        if (PackageVersionData.is(metadata)) {
            return Object.keys(metadata.versions).map(key => {
                const version = new SemVer(key);
                const time = getVersionTimestamp(metadata, key);
                return { version, time };
            });
        } else {
            return [];
        }
    }

    /**
     * Gets the version-specific metadata for a specific version of a package.
     *
     * If `version` is the name of a release channel, this gets the latest version in that channel.
     * If `version` is omitted, this gets the latest version for the user's selected channel.
     * @throws VersionMissingError if the given version does not exist.
     */
    public async getPackageVersionMetadata(name: string, version?: string) {
        const metadata = await this.getPackageMetadata(name);

        assertType(metadata, PackageVersionData, `In package "${name}"`);

        if (version === undefined) {
            const latest = lookupVersion(metadata, name, 'latest');
            if (typeof latest.publisher === 'string') {
                version = getReleaseChannel(latest.publisher, name);
            } else {
                version = 'latest';
            }
        }

        const manifest = lookupVersion(metadata, name, version);
        return new Package(this, manifest, version);
    }

    private async *findMatchingPackages(query: string | readonly string[], token?: CancellationToken) {
        let from = 0;
        while (true) {
            if (token?.isCancellationRequested) {
                break;
            }

            const page = await npmsearch(query, {
                ...this.options,
                'prefer-online': true,
                from,
                limit: QUERY_LIMIT,
            });

            for (const item of page) {
                yield item;
            }

            // The server may ignore our query limit and return as many results
            // as it wants. We've collected everything when it returns nothing.
            if (page.length === 0) {
                break;
            } else {
                from += page.length;
            }
        }
    }
}

function queryEquals(a: string | readonly string[], b: string | readonly string[]) {
    // libnpmsearch internally joins array queries with spaces, so
    // ["foo", "bar"] and "foo bar" are the same query.
    a = Array.isArray(a) ? a.join(' ') : a;
    b = Array.isArray(b) ? b.join(' ') : b;

    return a === b;
}

function getVersionTimestamp(meta: PackageVersionData, key: string) {
    const time = meta.time?.[key];
    return time ? new Date(time) : undefined;
}

/**
    Finds the version-specific metadata for a package given a version
    or dist-tag.
*/
function lookupVersion(metadata: PackageVersionData, name: string, versionOrTag: string) {
    if (versionOrTag in metadata['dist-tags']) {
        versionOrTag = metadata['dist-tags'][versionOrTag];
    }

    const result = metadata.versions[versionOrTag];
    if (result === undefined) {
        throw new VersionMissingError(name, versionOrTag);
    }

    return result;
}

/**
 * Gets the user's selected release channel for an extension, or 'latest'.
 */
function getReleaseChannel(publisher: string, name: string) {
    const id = `${publisher}.${name}`.toLowerCase();

    return getConfig().get<Record<string, string>>('channels')?.[id] ?? 'latest';
}
