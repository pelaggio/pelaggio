#!/usr/bin/env tsx
/** Companion to `pack-prepare.ts`; invoked by the package's `postpack` script. */
import { cleanSkillsOut } from "./pack-prepare.js";

cleanSkillsOut();
