// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Finding faces: the family's, in each style (made up where it lacks
//! one), and fallbacks for what it lacks, from the families asked for, an
//! emoji font, and fontconfig's for each script; the system's fonts listed
//! only when they are needed.

use super::*;

impl Fonts {
    /// The face of the family (else any monospace font) nearest to
    /// weight and style.
    pub(super) fn find(&mut self, weight: FontWeight, style: FontStyle) -> Option<usize> {
        let family = self.spec.family.clone();
        let mut query = self.collection.query(&mut self.cache);
        query.set_families([
            QueryFamily::Named(&family),
            match self.system {
                SystemFonts::Listed => QueryFamily::Generic(GenericFamily::Monospace),
                // Only the built-in fonts, or not yet the system's.
                SystemFonts::Never => QueryFamily::Named(BUILT_IN_FAMILY),
                SystemFonts::Unlisted => QueryFamily::Named(&family),
            },
        ]);
        query.set_attributes(Attributes::new(FontWidth::NORMAL, style, weight));
        let found = query.first_available_font()?;
        drop(query);
        self.face(found.blob, found.index, found.synthesis)
    }

    /// Lists the system's fonts, if they are not listed yet and may be;
    /// returns whether they are.
    pub(super) fn list_system_fonts(&mut self) -> bool {
        match self.system {
            SystemFonts::Listed => true,
            SystemFonts::Never => false,
            SystemFonts::Unlisted => {
                self.collection = collection(&self.built_in, true);
                self.cache = SourceCache::default();
                self.system = SystemFonts::Listed;
                timing::mark("system fonts listed");
                true
            }
        }
    }

    /// The face for a font, made up as `synthesis` says (fontique's, for
    /// the style it is wanted in): at another point on its axes where it
    /// has them (weight, slant), else emboldened or slanted.
    pub(super) fn face(
        &mut self,
        blob: fontique::Blob<u8>,
        index: u32,
        synthesis: Synthesis,
    ) -> Option<usize> {
        let key = (blob.id(), index, synthesis);
        if let Some(i) = self.faces.iter().position(|f| f.key == key) {
            return Some(i);
        }
        let (data, _) = blob.into_raw_parts();
        let mut font = skrifa::Font::new(data, index)?;
        let variations = synthesis.variation_settings();
        if !variations.is_empty() {
            font = font
                .instance_builder()
                .variations(
                    variations
                        .iter()
                        .map(|&(tag, value)| (skrifa::Tag::new(&tag.to_be_bytes()), value)),
                )
                .build();
        }
        let units_per_em = f32::from(font.units_per_em().max(1));
        let color = !font.color_glyphs().is_empty() || !font.bitmap_strikes().is_empty();
        self.faces.push(Face {
            font,
            key,
            units_per_em,
            embolden: if synthesis.embolden() { EMBOLDEN } else { 0.0 },
            slant: synthesis.skew().map_or(0.0, |deg| deg.to_radians().tan()),
            color,
        });
        Some(self.faces.len() - 1)
    }

    /// The face to draw `c` with in style `style`: the style's own, else a
    /// fallback font for c's script that has it, else the style's own
    /// (whose missing-glyph box says so).
    pub(super) fn face_for(&mut self, style: usize, cell: &Cell) -> usize {
        let c = cell.text.chars().next().unwrap_or(' ');
        let own = self.styles[style];
        let has = c.is_ascii() || self.faces[own].font.charmap().map_unicode(c).is_some();
        // Emoji shown as pictures: those asked to be, and those two cells
        // wide, as terminals show emoji that are pictures by default (an
        // emoji font has no other wide characters, so East Asian text
        // keeps its font).
        let emoji = cell.text.contains('\u{FE0F}') || cell.width == 2;
        if has && !emoji {
            return own;
        }
        if let Some(&face) = self.fallbacks.get(&(style, c, emoji)) {
            return face;
        }
        let face = emoji
            .then(|| self.emoji_face(style, c))
            .flatten()
            .or_else(|| {
                if has {
                    Some(own)
                } else {
                    self.fallback(style, c)
                }
            })
            .unwrap_or(own);
        self.fallbacks.insert((style, c, emoji), face);
        face
    }

    /// The first emoji font in color with `c`. (Fontconfig follows the
    /// emoji fonts with every other, so those without color are passed
    /// over: text finds its own font, styled.)
    pub(super) fn emoji_face(&mut self, style: usize, c: char) -> Option<usize> {
        if !self.list_system_fonts() {
            return None;
        }
        let (weight, slant) = attributes(style);
        let mut query = self.collection.query(&mut self.cache);
        query.set_families([QueryFamily::Generic(GenericFamily::Emoji)]);
        query.set_attributes(Attributes::new(FontWidth::NORMAL, slant, weight));
        let mut found = Vec::new();
        query.matches_with(|font| {
            if font.charmap().is_some_and(|m| m.map(c).is_some()) {
                found.push((font.blob.clone(), font.index));
            }
            QueryStatus::Continue
        });
        drop(query);
        // Pictures are not emboldened or slanted.
        found.into_iter().find_map(|(blob, index)| {
            self.face(blob, index, Synthesis::default())
                .filter(|&f| self.faces[f].color)
        })
    }

    pub(super) fn fallback(&mut self, style: usize, c: char) -> Option<usize> {
        if !self.list_system_fonts() {
            return None;
        }
        // The character's script, as HarfRust guesses it.
        let mut buffer = Buffer::new();
        buffer.push_str(c.encode_utf8(&mut [0; 4]));
        buffer.guess_segment_properties();
        let script = buffer
            .script()
            .map(|s| fontique::Script::from_bytes(s.tag().to_be_bytes()));
        let (weight, slant) = attributes(style);
        // The families asked for first, in order.
        for family in self.spec.fallbacks.clone() {
            let mut query = self.collection.query(&mut self.cache);
            query.set_families([QueryFamily::Named(&family)]);
            query.set_attributes(Attributes::new(FontWidth::NORMAL, slant, weight));
            let mut found = None;
            query.matches_with(|font| {
                if font.charmap().is_some_and(|m| m.map(c).is_some()) {
                    found = Some((font.blob.clone(), font.index, font.synthesis));
                }
                QueryStatus::Stop
            });
            drop(query);
            if let Some((blob, index, synthesis)) = found {
                return self.face(blob, index, synthesis);
            }
        }
        let mut query = self.collection.query(&mut self.cache);
        query.set_families([QueryFamily::Generic(GenericFamily::Monospace)]);
        query.set_attributes(Attributes::new(FontWidth::NORMAL, slant, weight));
        if let Some(script) = script {
            query.set_fallbacks(FallbackKey::new(script, None));
        }
        let mut found = None;
        query.matches_with(|font| {
            if font.charmap().is_some_and(|m| m.map(c).is_some()) {
                found = Some((font.blob.clone(), font.index, font.synthesis));
                QueryStatus::Stop
            } else {
                QueryStatus::Continue
            }
        });
        drop(query);
        if found.is_none() {
            found = self.any_family_with(c, slant, weight);
        }
        let (blob, index, synthesis) = found?;
        self.face(blob, index, synthesis)
    }

    /// The first font of any family that has `c`, for characters no script
    /// has fallbacks for (dingbats and other symbols are Common): slow, but
    /// once a character, as fontconfig's matching by character set is.
    pub(super) fn any_family_with(
        &mut self,
        c: char,
        slant: FontStyle,
        weight: FontWeight,
    ) -> Option<(fontique::Blob<u8>, u32, Synthesis)> {
        let families: Vec<fontique::FamilyId> = self.collection.family_ids().collect();
        for family in families {
            let mut query = self.collection.query(&mut self.cache);
            query.set_families([QueryFamily::Id(family)]);
            query.set_attributes(Attributes::new(FontWidth::NORMAL, slant, weight));
            let mut found = None;
            query.matches_with(|font| {
                if font.charmap().is_some_and(|m| m.map(c).is_some()) {
                    found = Some((font.blob.clone(), font.index, font.synthesis));
                }
                QueryStatus::Stop
            });
            if found.is_some() {
                return found;
            }
        }
        None
    }
}

/// The built-in fonts' family.
pub(super) const BUILT_IN_FAMILY: &str = "JetBrains Mono";

#[derive(Clone, Copy, PartialEq)]
pub(super) enum SystemFonts {
    /// Not listed yet: they are, once something needs them.
    Unlisted,
    Listed,
    /// Never to be listed.
    Never,
}

/// A collection of the built-in fonts, and the system's if `system`.
pub(super) fn collection(built_in: &[fontique::Blob<u8>], system: bool) -> Collection {
    let mut collection = Collection::new(CollectionOptions {
        shared: false,
        system_fonts: system,
    });
    for blob in built_in {
        collection.register_fonts(blob.clone(), None);
    }
    collection
}

/// The weight and slant of style `style` (bold 1, italic 2).
pub(super) fn attributes(style: usize) -> (FontWeight, FontStyle) {
    match style {
        1 => (FontWeight::BOLD, FontStyle::Normal),
        2 => (FontWeight::NORMAL, FontStyle::Italic),
        3 => (FontWeight::BOLD, FontStyle::Italic),
        _ => (FontWeight::NORMAL, FontStyle::Normal),
    }
}
