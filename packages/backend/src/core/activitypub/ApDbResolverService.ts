/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MiUser, NotesRepository, UserPublickeysRepository, UsersRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { MemoryKVCache } from '@/misc/cache.js';
import type { MiUserPublickey } from '@/models/UserPublickey.js';
import { CacheService } from '@/core/CacheService.js';
import type { MiNote } from '@/models/Note.js';
import { bindThis } from '@/decorators.js';
import { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { getApId } from './type.js';
import { ApPersonService } from './models/ApPersonService.js';
import type { IObject } from './type.js';

export type UriParseResult = {
	/** wether the URI was generated by us */
	local: true;
	/** id in DB */
	id: string;
	/** hint of type, e.g. "notes", "users" */
	type: string;
	/** any remaining text after type and id, not including the slash after id. undefined if empty */
	rest?: string;
} | {
	/** wether the URI was generated by us */
	local: false;
	/** uri in DB */
	uri: string;
};

@Injectable()
export class ApDbResolverService implements OnApplicationShutdown {
	private publicKeyByUserIdCache: MemoryKVCache<MiUserPublickey[] | null>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.userPublickeysRepository)
		private userPublickeysRepository: UserPublickeysRepository,

		private cacheService: CacheService,
		private apPersonService: ApPersonService,
	) {
		this.publicKeyByUserIdCache = new MemoryKVCache<MiUserPublickey[] | null>(Infinity);
	}

	@bindThis
	public parseUri(value: string | IObject): UriParseResult {
		const separator = '/';

		const uri = new URL(getApId(value));
		if (uri.origin !== this.config.url) return { local: false, uri: uri.href };

		const [, type, id, ...rest] = uri.pathname.split(separator);
		return {
			local: true,
			type,
			id,
			rest: rest.length === 0 ? undefined : rest.join(separator),
		};
	}

	/**
	 * AP Note => Misskey Note in DB
	 */
	@bindThis
	public async getNoteFromApId(value: string | IObject): Promise<MiNote | null> {
		const parsed = this.parseUri(value);

		if (parsed.local) {
			if (parsed.type !== 'notes') return null;

			return await this.notesRepository.findOneBy({
				id: parsed.id,
			});
		} else {
			return await this.notesRepository.findOneBy({
				uri: parsed.uri,
			});
		}
	}

	/**
	 * AP Person => Misskey User in DB
	 */
	@bindThis
	public async getUserFromApId(value: string | IObject): Promise<MiLocalUser | MiRemoteUser | null> {
		const parsed = this.parseUri(value);

		if (parsed.local) {
			if (parsed.type !== 'users') return null;

			return await this.cacheService.userByIdCache.fetchMaybe(
				parsed.id,
				() => this.usersRepository.findOneBy({ id: parsed.id, isDeleted: false }).then(x => x ?? undefined),
			) as MiLocalUser | undefined ?? null;
		} else {
			return await this.cacheService.uriPersonCache.fetch(
				parsed.uri,
				() => this.usersRepository.findOneBy({ uri: parsed.uri, isDeleted: false }),
			) as MiRemoteUser | null;
		}
	}

	/**
	 * AP Actor id => Misskey User and Key
	 * @param uri AP Actor id
	 * @param keyId Key id to find. If not specified, main key will be selected.
	 */
	@bindThis
	public async getAuthUserFromApId(uri: string, keyId?: string): Promise<{
		user: MiRemoteUser;
		key: MiUserPublickey | null;
	} | null> {
		const user = await this.apPersonService.resolvePerson(uri, undefined, true) as MiRemoteUser;
		if (user.isDeleted) return null;

		const keys = await this.getPublicKeyByUserId(user.id);

		if (keys == null || !Array.isArray(keys)) return { user, key: null };

		if (!keyId) {
			// mainっぽいのを選ぶ
			const mainKey = keys.find(x => {
				try {
					const url = new URL(x.keyId);
					const path = url.pathname.split('/').pop()?.toLowerCase();
					if (url.hash) {
						if (url.hash.toLowerCase().includes('main')) {
							return true;
						}
					} else if (path?.includes('main') || path === 'publickey') {
						return true;
					}
				} catch { /* noop */ }

				return false;
			});
			return { user, key: mainKey ?? keys[0] };
		}

		const exactKey = keys.find(x => x.keyId === keyId);
		if (exactKey) return { user, key: exactKey };

		// keyIdで見つからない場合
		// まずはキャッシュを更新して再取得
		const cacheRaw = this.publicKeyByUserIdCache.cache.get(user.id);
		if (cacheRaw && cacheRaw.date > Date.now() - 1000 * 60 * 12) {
			this.refreshCacheByUserId(user.id);
			const keys = await this.getPublicKeyByUserId(user.id);
			if (keys == null || !Array.isArray(keys)) return null;

			const exactKey = keys.find(x => x.keyId === keyId);
			if (exactKey) return { user, key: exactKey };
		}

		// lastFetchedAtでの更新制限を弱めて再取得
		if (user.lastFetchedAt == null || user.lastFetchedAt < new Date(Date.now() - 1000 * 60 * 12)) {
			const renewed = await this.apPersonService.fetchPersonWithRenewal(uri, 0);
			if (renewed == null || renewed.isDeleted) return null;

			this.refreshCacheByUserId(user.id);
			const keys = await this.getPublicKeyByUserId(user.id);
			if (keys == null || !Array.isArray(keys)) return null;

			const exactKey = keys.find(x => x.keyId === keyId);
			if (exactKey) return { user, key: exactKey };
		}

		return { user, key: null };
	}

	@bindThis
	public async getPublicKeyByUserId(userId: MiUser['id']): Promise<MiUserPublickey[] | null> {
		return await this.publicKeyByUserIdCache.fetch(
			userId,
			() => this.userPublickeysRepository.find({ where: { userId } }),
			v => v != null,
		);
	}

	@bindThis
	public refreshCacheByUserId(userId: MiUser['id']): void {
		this.publicKeyByUserIdCache.delete(userId);
	}

	@bindThis
	public dispose(): void {
		this.publicKeyByUserIdCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
