// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! `#[chez::procedure]`: a Rust function as a Scheme procedure. See the
//! `chez` crate.

use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::{
    Attribute, Expr, ExprLit, FnArg, Ident, ItemFn, Lit, LitStr, Meta, Pat, Path, ReturnType,
    Token, Type, Visibility, braced, parenthesized, parse_macro_input,
};

/// The hidden item describing procedure `f`.
fn export_ident(f: &Ident) -> Ident {
    format_ident!("__chez_procedure_{}", f)
}

/// Make a Rust function callable from Scheme.
///
/// Each parameter is converted from its Scheme argument by `FromScheme`, and
/// the result to Scheme by `IntoScheme`; a parameter of type `&Scope` is
/// passed the call's scope instead, and takes no argument. Options:
///
/// - `name = "foo!"`: the Scheme name, by default the Rust name with `-`
///   for `_`;
/// - `objects`: the procedure may return Rust objects inside other values
///   (one returning `Object<T>` is known to).
///
/// The function's doc comment documents the Scheme procedure too.
#[proc_macro_attribute]
pub fn procedure(attr: TokenStream, item: TokenStream) -> TokenStream {
    let mut name: Option<String> = None;
    let mut objects = false;
    let parser = syn::meta::parser(|meta| {
        if meta.path.is_ident("name") {
            name = Some(meta.value()?.parse::<LitStr>()?.value());
            Ok(())
        } else if meta.path.is_ident("objects") {
            objects = true;
            Ok(())
        } else {
            Err(meta.error("expected `name = \"...\"` or `objects`"))
        }
    });
    parse_macro_input!(attr with parser);
    let f = parse_macro_input!(item as ItemFn);
    match expand(f, name, objects) {
        Ok(t) => t.into(),
        Err(e) => e.to_compile_error().into(),
    }
}

fn is_scope(ty: &Type) -> bool {
    match ty {
        Type::Reference(r) => match &*r.elem {
            Type::Path(p) => p.path.segments.last().is_some_and(|s| s.ident == "Scope"),
            _ => false,
        },
        _ => false,
    }
}

fn expand(f: ItemFn, name: Option<String>, objects: bool) -> syn::Result<proc_macro2::TokenStream> {
    let ident = &f.sig.ident;
    let export = export_ident(ident);
    let vis = &f.vis;
    if f.sig.generics.type_params().next().is_some() {
        return Err(syn::Error::new_spanned(
            &f.sig.generics,
            "a Scheme procedure cannot be generic over types",
        ));
    }
    if f.sig.asyncness.is_some() {
        return Err(syn::Error::new_spanned(
            f.sig.asyncness,
            "a Scheme procedure cannot be async",
        ));
    }
    let scheme_name = name.unwrap_or_else(|| ident.to_string().replace('_', "-"));

    let doc = f
        .attrs
        .iter()
        .filter_map(|a| match &a.meta {
            Meta::NameValue(nv) if nv.path.is_ident("doc") => match &nv.value {
                Expr::Lit(ExprLit {
                    lit: Lit::Str(s), ..
                }) => Some(s.value()),
                _ => None,
            },
            _ => None,
        })
        .map(|line| line.strip_prefix(' ').map(str::to_string).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n");

    let mut raws = Vec::new();
    let mut lets = Vec::new();
    let mut call_args = Vec::new();
    let mut param_names = Vec::new();
    for input in &f.sig.inputs {
        let FnArg::Typed(pt) = input else {
            return Err(syn::Error::new_spanned(
                input,
                "a Scheme procedure cannot take self",
            ));
        };
        let Pat::Ident(pi) = &*pt.pat else {
            return Err(syn::Error::new_spanned(
                &pt.pat,
                "parameters must be plain names",
            ));
        };
        let pname = &pi.ident;
        if is_scope(&pt.ty) {
            call_args.push(quote!(scope));
            continue;
        }
        let index = raws.len() + 1;
        let raw = format_ident!("__arg{}", index);
        let shown = pname.to_string().trim_start_matches('_').replace('_', "-");
        // The type comes from the call below, by inference: it may name the
        // function's own lifetimes, which do not exist here.
        lets.push(quote! {
            let #pname = ::chez::__private::arg(scope, #raw, #index, #shown)?;
        });
        call_args.push(quote!(#pname));
        param_names.push(shown);
        raws.push(raw);
    }

    let returns_objects = objects
        || match &f.sig.output {
            ReturnType::Type(_, ty) => quote!(#ty).to_string().contains("Object"),
            ReturnType::Default => false,
        };

    Ok(quote! {
        #f

        #[doc(hidden)]
        #[allow(non_camel_case_types)]
        #vis struct #export {}

        impl ::chez::Export for #export {
            fn procedure() -> ::chez::Procedure {
                unsafe extern "C" fn __entry(#(#raws: ::chez::sys::Ptr),*) -> ::chez::sys::Ptr {
                    ::chez::__private::call(|scope| {
                        #(#lets)*
                        ::chez::__private::ret(scope, #ident(#(#call_args),*))
                    })
                }
                ::chez::Procedure {
                    name: #scheme_name,
                    params: &[#(#param_names),*],
                    doc: #doc,
                    objects: #returns_objects,
                    entry: __entry as *const ::std::ffi::c_void,
                }
            }
        }
    })
}

struct LibraryInput {
    attrs: Vec<Attribute>,
    vis: Visibility,
    ident: Ident,
    name: LitStr,
    procedures: Punctuated<Path, Token![,]>,
}

impl Parse for LibraryInput {
    fn parse(input: ParseStream) -> syn::Result<LibraryInput> {
        let attrs = input.call(Attribute::parse_outer)?;
        let vis = input.parse()?;
        input.parse::<Token![fn]>()?;
        let ident = input.parse()?;
        let _args;
        parenthesized!(_args in input);
        input.parse::<Token![->]>()?;
        let name = input.parse()?;
        let body;
        braced!(body in input);
        let procedures = body.parse_terminated(Path::parse, Token![,])?;
        Ok(LibraryInput {
            attrs,
            vis,
            ident,
            name,
            procedures,
        })
    }
}

/// `library! { pub fn native() -> "quad native" { blake3, version } }`
/// defines `native()`, the `chez::Library` named `(quad native)` of those
/// `#[chez::procedure]`s (which may be paths: `module::f`).
#[proc_macro]
pub fn library(input: TokenStream) -> TokenStream {
    let LibraryInput {
        attrs,
        vis,
        ident,
        name,
        procedures,
    } = parse_macro_input!(input as LibraryInput);
    let exports = procedures.iter().map(|p| {
        let mut p = p.clone();
        let last = p.segments.last_mut().expect("a path");
        last.ident = export_ident(&last.ident);
        p
    });
    quote! {
        #(#attrs)*
        #vis fn #ident() -> ::chez::Library {
            ::chez::Library {
                name: #name,
                procedures: vec![#(<#exports as ::chez::Export>::procedure()),*],
            }
        }
    }
    .into()
}
