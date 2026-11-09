// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
//
// The text shader below is Eric Lengyel's reference Slug pixel shader
// (https://github.com/EricLengyel/Slug, at be3c13eb), ported to Slang:
//
//     Slug shader code Copyright 2017 by Eric Lengyel.
//     SPDX-License-Identifier: MIT OR Apache-2.0
//
// The Slug algorithm's patent is dedicated to the public domain.

// The GUI's pipelines (kernel/render/). There are no vertex buffers or
// descriptor sets: the push constants point at the frame's data by buffer
// device address, and each instance draws one rectangle or glyph as a
// four-vertex strip.
//
// - Rectangles, placed in cells and filled with a color: the cells'
//   backgrounds, the cursor, underlines.
// - Images (pictures), placed in pixels and read from the frame's pixels,
//   one for each drawn (kernel/image.rs scales them so).
// - Glyphs, drawn from their curves with Slug: text, and box drawing.
//
// Colors are sRGB-encoded 0xAARRGGBB. Where the image drawn into is sRGB
// (params.linear), they are made linear here, the hardware blends in
// linear light and encodes the result, and text's coverage is corrected as
// ghostty's "linear-corrected" alpha blending (its default on Linux) does,
// so that glyphs keep the weight gamma-space blending gives them; else
// colors are written as they are and blended encoded ("native"). Either
// way, solid colors come out exactly as a terminal shows them.

struct Rect
{
    float4 bounds; // x, y, width, height, in cells: (0, 0) is the top left
    uint color;    // 0xAARRGGBB; alpha 255 is opaque
    uint3 reserved;
};

// A glyph, placed (kernel/font/layout.rs makes these; slug.rs, the data).
struct Glyph
{
    float4 rect;    // its quad, in pixels: x, y, width, height
    float4 em;      // em-space coordinates at the quad's left, top, right and bottom
    float4 banding; // band scale (x, y) and offset (x, y)
    uint location;  // its data in the band buffer
    uint bandMax;   // the last vertical band (low 16 bits) and horizontal band (high)
    uint color;     // 0xAARRGGBB
    uint background; // 0xRRGGBB behind it, for the blending correction
};

// An image, placed (kernel/image.rs makes these).
struct Picture
{
    float4 rect;  // where, in pixels: x, y, width, height
    uint offset;  // its first pixel in the frame's pixels
    uint stride;  // its pixels in a row
    uint2 reserved;
};

struct Params
{
    Rect* rects;
    Glyph* glyphs;
    float4* curves; // control points: (x1, y1, x2, y2), a curve per two texels
    uint2* bands;   // band headers (count, offset) and curve lists
    Picture* pictures;
    uint* pixels;   // RGBA bytes, sRGB-encoded, alpha not premultiplied
    float2 cell;     // a cell's size, in pixels
    float2 viewport; // the window's size, in pixels
    float2 origin;   // where the grid's top left is, in pixels (the window's padding)
    uint linear;     // nonzero: blend in linear light (an sRGB image)
    uint reserved;
};

[[vk::push_constant]] Params params;

float linearize(float v)
{
    return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}

float unlinearize(float v)
{
    return v <= 0.0031308 ? v * 12.92 : pow(v, 1.0 / 2.4) * 1.055 - 0.055;
}

// A color as the shaders work in: linear where params.linear says so.
float4 unpackColor(uint color)
{
    float4 c = float4(float((color >> 16) & 0xFF), float((color >> 8) & 0xFF), float(color & 0xFF),
                      float(color >> 24)) / 255.0;
    if (params.linear != 0)
        c.rgb = float3(linearize(c.r), linearize(c.g), linearize(c.b));
    return c;
}

float luminance(float3 linearColor)
{
    return dot(linearColor, float3(0.2126, 0.7152, 0.0722));
}

float4 clipPosition(float2 pixel)
{
    // Vulkan's clip space runs top to bottom, as pixels do.
    return float4((pixel + params.origin) / params.viewport * 2.0 - 1.0, 0.0, 1.0);
}

float2 corner(uint vertex)
{
    return float2(float(vertex & 1), float((vertex >> 1) & 1));
}

// MARK: Rectangles

struct RectVertex
{
    float4 position : SV_Position;
    float4 color : COLOR0;
};

[shader("vertex")]
RectVertex rectVertex(uint vertex : SV_VertexID, uint instance : SV_InstanceID)
{
    Rect rect = params.rects[instance];
    RectVertex output;
    output.position = clipPosition((rect.bounds.xy + corner(vertex) * rect.bounds.zw) * params.cell);
    output.color = unpackColor(rect.color);
    return output;
}

[shader("fragment")]
float4 rectFragment(RectVertex input) : SV_Target0
{
    return input.color;
}

// MARK: Images

struct PictureVertex
{
    float4 position : SV_Position;
    float2 pixel : TEXCOORD0; // where in the picture, in its pixels
    nointerpolation uint instance : TEXCOORD1;
};

[shader("vertex")]
PictureVertex imageVertex(uint vertex : SV_VertexID, uint instance : SV_InstanceID)
{
    Picture picture = params.pictures[instance];
    float2 at = corner(vertex) * picture.rect.zw;
    PictureVertex output;
    output.position = clipPosition(picture.rect.xy + at);
    output.pixel = at;
    output.instance = instance;
    return output;
}

[shader("fragment")]
float4 imageFragment(PictureVertex input) : SV_Target0
{
    Picture picture = params.pictures[input.instance];
    uint2 p = min(uint2(input.pixel), uint2(picture.rect.zw) - 1);
    uint rgba = params.pixels[picture.offset + p.y * picture.stride + p.x];
    // 0xAABBGGRR, as unpackColor's 0xAARRGGBB.
    return unpackColor((rgba & 0xFF00FF00) | ((rgba & 0xFF) << 16) | ((rgba >> 16) & 0xFF));
}

// MARK: Glyphs

struct GlyphVertex
{
    float4 position : SV_Position;
    float4 color : COLOR0;
    float2 texcoord : TEXCOORD0;                // em-space sample coordinates
    nointerpolation float4 banding : TEXCOORD1; // band scale and offset, constant over the glyph
    nointerpolation uint4 glyph : TEXCOORD2;    // (location, band max x, band max y, 0)
    nointerpolation float4 background : COLOR1;
};

// The quad is the glyph's bounds, already a pixel wider on each side for
// its edges' antialiasing (font/layout.rs): text here is never rotated or skewed,
// so it needs none of the reference vertex shader's dynamic dilation.
[shader("vertex")]
GlyphVertex glyphVertex(uint vertex : SV_VertexID, uint instance : SV_InstanceID)
{
    Glyph glyph = params.glyphs[instance];
    float2 c = corner(vertex);
    GlyphVertex output;
    output.position = clipPosition(glyph.rect.xy + c * glyph.rect.zw);
    output.texcoord = lerp(glyph.em.xy, glyph.em.zw, c);
    output.color = unpackColor(glyph.color);
    output.background = unpackColor(glyph.background | 0xFF000000);
    output.banding = glyph.banding;
    output.glyph = uint4(glyph.location, glyph.bandMax & 0xFFFF, glyph.bandMax >> 16, 0);
    return output;
}

// From here to SlugRender, Lengyel's reference, but for where the data is:
// it reads a 4096-wide curve texture and band texture by (x, y); these are
// flat buffers, so locations are indexes, and CalcBandLoc's wrapping to the
// next row is just addition.

uint CalcRootCode(float y1, float y2, float y3)
{
    // Calculate the root eligibility code for a sample-relative quadratic Bézier curve.
    // Extract the signs of the y coordinates of the three control points.

    uint i1 = asuint(y1) >> 31U;
    uint i2 = asuint(y2) >> 30U;
    uint i3 = asuint(y3) >> 29U;

    uint shift = (i2 & 2U) | (i1 & ~2U);
    shift = (i3 & 4U) | (shift & ~4U);

    // Eligibility is returned in bits 0 and 8.

    return ((0x2E74U >> shift) & 0x0101U);
}

float2 SolveHorizPoly(float4 p12, float2 p3)
{
    // Solve for the values of t where the curve crosses y = 0.
    // The quadratic polynomial in t is given by
    //
    //     a t^2 - 2b t + c,
    //
    // where a = p1.y - 2 p2.y + p3.y, b = p1.y - p2.y, and c = p1.y.
    // The discriminant b^2 - ac is clamped to zero, and imaginary
    // roots are treated as a double root at the global minimum
    // where t = b / a.

    float2 a = p12.xy - p12.zw * 2.0 + p3;
    float2 b = p12.xy - p12.zw;
    float ra = 1.0 / a.y;
    float rb = 0.5 / b.y;

    float d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
    float t1 = (b.y - d) * ra;
    float t2 = (b.y + d) * ra;

    // If the polynomial is nearly linear, then solve -2b t + c = 0.

    if (abs(a.y) < 1.0 / 65536.0) t1 = t2 = p12.y * rb;

    // Return the x coordinates where C(t) = 0.

    return (float2((a.x * t1 - b.x * 2.0) * t1 + p12.x, (a.x * t2 - b.x * 2.0) * t2 + p12.x));
}

float2 SolveVertPoly(float4 p12, float2 p3)
{
    // Solve for the values of t where the curve crosses x = 0.

    float2 a = p12.xy - p12.zw * 2.0 + p3;
    float2 b = p12.xy - p12.zw;
    float ra = 1.0 / a.x;
    float rb = 0.5 / b.x;

    float d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
    float t1 = (b.x - d) * ra;
    float t2 = (b.x + d) * ra;

    // If the polynomial is nearly linear, then solve -2b t + c = 0.

    if (abs(a.x) < 1.0 / 65536.0) t1 = t2 = p12.x * rb;

    // Return the y coordinates where C(t) = 0.

    return (float2((a.y * t1 - b.y * 2.0) * t1 + p12.y, (a.y * t2 - b.y * 2.0) * t2 + p12.y));
}

float CalcCoverage(float xcov, float ycov, float xwgt, float ywgt)
{
    // Combine coverages from the horizontal and vertical rays using their weights.
    // Absolute values ensure that either winding direction convention works.

    float coverage = max(abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0), min(abs(xcov), abs(ycov)));

    // Using nonzero fill rule here.

    return saturate(coverage);
}

float SlugRender(float2 renderCoord, float4 bandTransform, uint4 glyphData)
{
    // The effective pixel dimensions of the em square are computed
    // independently for x and y directions with texcoord derivatives.

    float2 emsPerPixel = fwidth(renderCoord);
    float2 pixelsPerEm = 1.0 / emsPerPixel;

    int2 bandMax = int2(glyphData.yz);

    // Determine what bands the current pixel lies in by applying a scale and offset
    // to the render coordinates. The scales are given by bandTransform.xy, and the
    // offsets are given by bandTransform.zw. Band indexes are clamped to [0, bandMax.xy].

    int2 bandIndex = clamp(int2(renderCoord * bandTransform.xy + bandTransform.zw), int2(0, 0), bandMax);
    uint glyphLoc = glyphData.x;

    float xcov = 0.0;
    float xwgt = 0.0;

    // Fetch data for the horizontal band. The number of curves intersecting
    // the band is in the x component, and the offset to the list of
    // locations for those curves is in the y component.

    uint2 hbandData = params.bands[glyphLoc + uint(bandIndex.y)];
    uint hbandLoc = glyphLoc + hbandData.y;

    // Loop over all curves in the horizontal band.

    for (uint curveIndex = 0; curveIndex < hbandData.x; curveIndex++)
    {
        // Fetch the location of the current curve.

        uint curveLoc = params.bands[hbandLoc + curveIndex].x;

        // Fetch the three 2D control points for the current curve.
        // The first texel contains both p1 and p2 in the (x,y) and (z,w) components, respectively,
        // and the the second texel contains p3 in the (x,y) components. Subtracting the render
        // coordinates makes the curve relative to the sample position. The quadratic Bézier curve
        // C(t) is given by
        //
        //     C(t) = (1 - t)^2 p1 + 2t(1 - t) p2 + t^2 p3

        float4 p12 = params.curves[curveLoc] - float4(renderCoord, renderCoord);
        float2 p3 = params.curves[curveLoc + 1].xy - renderCoord;

        // If the largest x coordinate among all three control points falls
        // left of the current pixel, then there are no more curves in the
        // horizontal band that can influence the result, so exit the loop.
        // (The curves are sorted in descending order by max x coordinate.)

        if (max(max(p12.x, p12.z), p3.x) * pixelsPerEm.x < -0.5) break;

        uint code = CalcRootCode(p12.y, p12.w, p3.y);
        if (code != 0U)
        {
            // At least one root makes a contribution. Calculate them and scale so
            // that the current pixel corresponds to the range [0,1].

            float2 r = SolveHorizPoly(p12, p3) * pixelsPerEm.x;

            // Bits in code tell which roots make a contribution.

            if ((code & 1U) != 0U)
            {
                xcov += saturate(r.x + 0.5);
                xwgt = max(xwgt, saturate(1.0 - abs(r.x) * 2.0));
            }

            if (code > 1U)
            {
                xcov -= saturate(r.y + 0.5);
                xwgt = max(xwgt, saturate(1.0 - abs(r.y) * 2.0));
            }
        }
    }

    float ycov = 0.0;
    float ywgt = 0.0;

    // Fetch data for the vertical band. This follows the data for all
    // horizontal bands, so we have to add bandMax.y + 1.

    uint2 vbandData = params.bands[glyphLoc + uint(bandMax.y) + 1 + uint(bandIndex.x)];
    uint vbandLoc = glyphLoc + vbandData.y;

    // Loop over all curves in the vertical band.

    for (uint curveIndex = 0; curveIndex < vbandData.x; curveIndex++)
    {
        uint curveLoc = params.bands[vbandLoc + curveIndex].x;
        float4 p12 = params.curves[curveLoc] - float4(renderCoord, renderCoord);
        float2 p3 = params.curves[curveLoc + 1].xy - renderCoord;

        // If the largest y coordinate among all three control points falls
        // below the current pixel, then there are no more curves in the
        // vertical band that can influence the result, so exit the loop.
        // (The curves are sorted in descending order by max y coordinate.)

        if (max(max(p12.y, p12.w), p3.y) * pixelsPerEm.y < -0.5) break;

        uint code = CalcRootCode(p12.x, p12.z, p3.x);
        if (code != 0U)
        {
            float2 r = SolveVertPoly(p12, p3) * pixelsPerEm.y;

            if ((code & 1U) != 0U)
            {
                ycov -= saturate(r.x + 0.5);
                ywgt = max(ywgt, saturate(1.0 - abs(r.x) * 2.0));
            }

            if (code > 1U)
            {
                ycov += saturate(r.y + 0.5);
                ywgt = max(ywgt, saturate(1.0 - abs(r.y) * 2.0));
            }
        }
    }

    return (CalcCoverage(xcov, ycov, xwgt, ywgt));
}

[shader("fragment")]
float4 glyphFragment(GlyphVertex input) : SV_Target0
{
    float a = SlugRender(input.texcoord, input.banding, input.glyph);
    // ghostty's linear-corrected blending (src/renderer/shaders, MIT):
    // blend the luminances as gamma-space blending would, and take the
    // coverage that gives that luminance blending linearly from the
    // background to the text's color. Text then keeps the weight it has in
    // a terminal blending gamma-encoded colors, without that blending's
    // muddy colors.
    if (params.linear != 0)
    {
        float fg = luminance(input.color.rgb);
        float bg = luminance(input.background.rgb);
        if (abs(fg - bg) > 0.001)
        {
            float blended = linearize(unlinearize(fg) * a + unlinearize(bg) * (1.0 - a));
            a = saturate((blended - bg) / (fg - bg));
        }
    }
    // Straight alpha, as the pipeline blends it.
    return float4(input.color.rgb, input.color.a * a);
}
