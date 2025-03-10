/**
 * Modified version of Vendicated's loadLazyChunks.ts
 * @link https://github.com/Vendicated/Vencord/blob/main/src/debug/loadLazyChunks.ts
 */
import { Logger } from "@utils/logger";
import { canonicalizeMatch } from "@utils/patches";
import { ChunkIdsRegex, factoryListeners, wreq } from "@webpack";

const logger = new Logger("LazyChunkLoader");

export const loadLazyChunks = async () => {
    try {
        logger.log("Loading all chunks...");

        const validChunks = new Set<number>();
        const invalidChunks = new Set<number>();
        const deferredRequires = new Set<number>();

        let chunksSearchingResolve: (value: void | PromiseLike<void>) => void;
        const chunksSearchingDone = new Promise<void>((r) => (chunksSearchingResolve = r));

        // True if resolved, false otherwise
        const chunksSearchPromises = [] as Array<() => boolean>;

        const LazyChunkRegex = canonicalizeMatch(
            /(?:(?:Promise\.all\(\[)?(\i\.e\("?[^)]+?"?\)[^\]]*?)(?:\]\))?)\.then\(\i\.bind\(\i,"?([^)]+?)"?\)\)/g
        );

        async function searchAndLoadLazyChunks(factoryCode: string) {
            const lazyChunks = factoryCode.matchAll(LazyChunkRegex);
            const validChunkGroups = new Set<[chunkIds: number[], entryPoint: number]>();

            const shouldForceDefer = false;

            await Promise.all(
                Array.from(lazyChunks).map(async ([, rawChunkIds, entryPoint]) => {
                    const chunkIds = rawChunkIds
                        ? Array.from(rawChunkIds.matchAll(ChunkIdsRegex)).map((m) => Number(m[1]))
                        : [];

                    if (chunkIds.length === 0) {
                        return;
                    }

                    let invalidChunkGroup = false;

                    for (const id of chunkIds) {
                        if (wreq.u(id) === null || wreq.u(id) === "undefined.js") {
                            continue;
                        }

                        const isWorkerAsset = await fetch(wreq.p + wreq.u(id))
                            .then((r) => r.text())
                            .then((t) => t.includes("importScripts("));

                        if (isWorkerAsset) {
                            invalidChunks.add(id);
                            invalidChunkGroup = true;
                            continue;
                        }

                        validChunks.add(id);
                    }

                    if (!invalidChunkGroup) {
                        validChunkGroups.add([chunkIds, Number(entryPoint)]);
                    }
                })
            );

            // Loads all found valid chunk groups
            await Promise.all(
                Array.from(validChunkGroups).map(([chunkIds]) =>
                    Promise.all(chunkIds.map((id) => wreq.e(id as any).catch(() => {})))
                )
            );

            // Requires the entry points for all valid chunk groups
            for (const [, entryPoint] of validChunkGroups) {
                try {
                    if (shouldForceDefer) {
                        deferredRequires.add(entryPoint);
                        continue;
                    }

                    if (wreq.m[entryPoint]) {
                        wreq(entryPoint as any);
                    }
                } catch (err) {
                    console.error(err);
                }
            }

            // setTimeout 0 to only check if all chunks were loaded after this function resolves
            // We check if all chunks were loaded every time a factory is loaded
            // If we are still looking for chunks in the other factories, the array will have that factory's chunk search promise not resolved
            // But, if all chunk search promises are resolved, this means we found every lazy chunk and manually loaded them
            setTimeout(() => {
                let allResolved = true;

                for (let i = 0; i < chunksSearchPromises.length; i++) {
                    const isResolved = chunksSearchPromises[i]();

                    if (isResolved) {
                        // Remove finished promises to avoid having to iterate through a huge array everytime
                        chunksSearchPromises.splice(i--, 1);
                    } else {
                        allResolved = false;
                    }
                }

                if (allResolved) {
                    chunksSearchingResolve();
                }
            }, 0);
        }

        factoryListeners.add((factory) => {
            let isResolved = false;
            searchAndLoadLazyChunks(factory.toString()).then(() => (isResolved = true));

            chunksSearchPromises.push(() => isResolved);
        });

        for (const factoryId in wreq.m) {
            let isResolved = false;
            searchAndLoadLazyChunks(wreq.m[factoryId].toString()).then(() => (isResolved = true));

            chunksSearchPromises.push(() => isResolved);
        }

        await chunksSearchingDone;

        // Require deferred entry points
        for (const deferredRequire of deferredRequires) {
            wreq!(deferredRequire as any);
        }

        const allChunks = [] as number[];

        // Matches "id" or id:
        for (const currentMatch of wreq!.u.toString().matchAll(/(?:"([\deE]+?)"(?![,}]))|(?:([\deE]+?):)/g)) {
            const id = currentMatch[1] ?? currentMatch[2];
            if (id === null) {
                continue;
            }

            allChunks.push(Number(id));
        }

        if (allChunks.length === 0) {
            throw new Error("Failed to get all chunks");
        }

        // Chunks that are not loaded (not used) anymore
        const chunksLeft = allChunks.filter((id) => {
            return !(validChunks.has(id) || invalidChunks.has(id));
        });

        await Promise.all(
            chunksLeft.map(async (id) => {
                const isWorkerAsset = await fetch(wreq.p + wreq.u(id))
                    .then((r) => r.text())
                    .then((t) => t.includes("importScripts("));

                // Loads and requires a chunk
                if (!isWorkerAsset) {
                    await wreq.e(id as any);
                    // Technically, the id of the chunk does not match the entry point
                    // But, still try it because we have no way to get the actual entry point
                    if (wreq.m[id]) {
                        wreq(id as any);
                    }
                }
            })
        );

        logger.log("Finished loading all chunks!");
    } catch (e) {
        logger.log("A fatal error occurred:", e);
    }
};
