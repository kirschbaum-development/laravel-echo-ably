const STRIP_PREFIXES = [
    "public:",
    "private-encrypted-",
    "private:",
    "private-",
    "presence:",
    "presence-",
] as const;

export function baseName(name: string): string {
    for (const prefix of STRIP_PREFIXES) {
        if (name.startsWith(prefix)) {
            return name.slice(prefix.length);
        }
    }

    return name;
}

export function toPublic(name: string): string {
    return "public:" + baseName(name);
}

export function toPrivate(name: string): string {
    return "private:" + baseName(name);
}

export function toPresence(name: string): string {
    return "presence:" + baseName(name);
}

export function normalize(name: string): string {
    if (
        name.startsWith("private:") ||
        name.startsWith("presence:") ||
        name.startsWith("public:")
    ) {
        return name;
    }

    if (name.startsWith("private-encrypted-") || name.startsWith("private-")) {
        return toPrivate(name);
    }

    if (name.startsWith("presence-")) {
        return toPresence(name);
    }

    return toPublic(name);
}

export function isGuarded(name: string): boolean {
    return name.startsWith("private:") || name.startsWith("presence:");
}
