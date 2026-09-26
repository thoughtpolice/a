# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The data the generators make regen-all leaves out download, named as each
# generator opens it: the Unicode Character Database of the version
# unicodedata reports and of 3.2.0, which unicodedata.ucd_3_2_0 serves to
# IDNA, and the East Asian mapping tables of the CJK codecs.

UNICODE_DATA = {
    "CaseFolding-16.0.0.txt": {
        "sha256": "6f1f9c588eb4a5c718d9e8f93b782685e5c7fec872cf05e8e6878053599e09bb",
        "size": 86092,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/CaseFolding.txt",
    },
    "CompositionExclusions-16.0.0.txt": {
        "sha256": "89e83cf9cc8bef6c1f8bf77e42cf6f0341dfa42e66261f4dbe9b492e7a23c8ee",
        "size": 9007,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/CompositionExclusions.txt",
    },
    "DerivedCoreProperties-16.0.0.txt": {
        "sha256": "39d35161f2954497f69e08bdb9e701493f476a3d30222de20028feda36c1dabd",
        "size": 1115959,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/DerivedCoreProperties.txt",
    },
    "DerivedNormalizationProps-16.0.0.txt": {
        "sha256": "4d4c03892dea9146d674b686e495df2d55a28d071ac474041d73518f887abddc",
        "size": 1372269,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/DerivedNormalizationProps.txt",
    },
    "EastAsianWidth-16.0.0.txt": {
        "sha256": "43adc76c0686a42cb370764eb8cfe2b2a45b10b855e5572a2db4a0eecce15d5b",
        "size": 199042,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/EastAsianWidth.txt",
    },
    "LineBreak-16.0.0.txt": {
        "sha256": "e97e4259d0d20fab150b9c7b4b28abfae5cd78ca97e7f4ac6ed20d685d5f4a7c",
        "size": 260441,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/LineBreak.txt",
    },
    "NameAliases-16.0.0.txt": {
        "sha256": "9953f0fcebf5ea8091c5c581e4df0e43f20d2533c84ccca7987a9bb819a896a8",
        "size": 16533,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/NameAliases.txt",
    },
    "NamedSequences-16.0.0.txt": {
        "sha256": "4ff660cb922480cd5aab9a689b1a6905d0a54575baf9967d0f1e00ac866f04dd",
        "size": 20876,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/NamedSequences.txt",
    },
    "SpecialCasing-16.0.0.txt": {
        "sha256": "8d5de354eef79f2395a54c9c7dcebbaf3d30fc962d0f85611ea97aa973a0c451",
        "size": 16809,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/SpecialCasing.txt",
    },
    "UnicodeData-16.0.0.txt": {
        "sha256": "ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f",
        "size": 2175362,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/UnicodeData.txt",
    },
    "Unihan-16.0.0.zip": {
        "sha256": "b8f000df69de7828d21326a2ffea462b04bc7560022989f7cc704f10521ef3e0",
        "size": 8382485,
        "url": "https://www.unicode.org/Public/16.0.0/ucd/Unihan.zip",
    },
    "CompositionExclusions-3.2.0.txt": {
        "sha256": "1d3a450d0f39902710df4972ac4a60ec31fbcb54ffd4d53cd812fc1200c732cb",
        "size": 7457,
        "url": "https://www.unicode.org/Public/3.2-Update/CompositionExclusions-3.2.0.txt",
    },
    "DerivedCoreProperties-3.2.0.txt": {
        "sha256": "787419dde91701018d7ad4f47432eaa55af14e3fe3fe140a11e4bbf3db18bb4c",
        "size": 341325,
        "url": "https://www.unicode.org/Public/3.2-Update/DerivedCoreProperties-3.2.0.txt",
    },
    "DerivedNormalizationProps-3.2.0.txt": {
        "sha256": "bab49295e5f9064213762447224ccd83cea0cced0db5dcfc96f9c8a935ef67ee",
        "size": 190633,
        "url": "https://www.unicode.org/Public/3.2-Update/DerivedNormalizationProps-3.2.0.txt",
    },
    "EastAsianWidth-3.2.0.txt": {
        "sha256": "ce19f35ffca911bf492aab6c0d3f6af3d1932f35d2064cf2fe14e10be29534cb",
        "size": 514234,
        "url": "https://www.unicode.org/Public/3.2-Update/EastAsianWidth-3.2.0.txt",
    },
    "LineBreak-3.2.0.txt": {
        "sha256": "d693ef2a603d07e20b769ef8ba29afca39765588a03e3196294e5be8638ca735",
        "size": 528246,
        "url": "https://www.unicode.org/Public/3.2-Update/LineBreak-3.2.0.txt",
    },
    "SpecialCasing-3.2.0.txt": {
        "sha256": "1f7913b74dddff55ee566f6220aa9e465bae6f27709fc21d353b04adb8572b37",
        "size": 15273,
        "url": "https://www.unicode.org/Public/3.2-Update/SpecialCasing-3.2.0.txt",
    },
    "UnicodeData-3.2.0.txt": {
        "sha256": "5e444028b6e76d96f9dc509609c5e3222bf609056f35e5fcde7e6fb8a58cd446",
        "size": 836989,
        "url": "https://www.unicode.org/Public/3.2-Update/UnicodeData-3.2.0.txt",
    },
    "Unihan-3.2.0.zip": {
        "sha256": "0582b888c4ebab6e3ce8d340c74788f1a68ca662713a1065b9a007f24bb4fe46",
        "size": 5198205,
        "url": "https://www.unicode.org/Public/3.2-Update/Unihan-3.2.0.zip",
    },
}

CJK_MAPPINGS = {
    "BIG5.txt": {
        "sha256": "d1b60c58a1d327918f1616a620162c60ad2079a229ee42a73488f186e11f3aac",
        "size": 316634,
        "url": "https://unicode.org/Public/MAPPINGS/OBSOLETE/EASTASIA/OTHER/BIG5.TXT",
    },
    "CP932.TXT": {
        "sha256": "c9bc0b0cd42e0fbcb82a09635bb5abed86afbdd4abc9e76fa5716638217cb59f",
        "size": 295324,
        "url": "https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP932.TXT",
    },
    "CP936.TXT": {
        "sha256": "b86f601c575e9ab457380b6f7abef03c75499cc6075bdc8b4b27f3f2de74bf6a",
        "size": 817310,
        "url": "https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP936.TXT",
    },
    "CP949.TXT": {
        "sha256": "f57e6fef9d1ed44f445e319a8e1b879ce6b6064520ab571c341e47b892e32abc",
        "size": 790736,
        "url": "https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP949.TXT",
    },
    "CP950.TXT": {
        "sha256": "ed403857b05e07ecd5667c7eff6b25898cb1fefe2d06cfe718d82d631e6058b6",
        "size": 508978,
        "url": "https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP950.TXT",
    },
    "JIS0208.TXT": {
        "sha256": "1c571870457f19c97720631fa83ee491549a96ba1436da1296786a67d8632e87",
        "size": 210734,
        "url": "https://www.unicode.org/Public/MAPPINGS/OBSOLETE/EASTASIA/JIS/JIS0208.TXT",
    },
    "JIS0212.TXT": {
        "sha256": "477820bb3055bbcc90880d788cd95607d221dc94457bae249231adecf13c12e6",
        "size": 143486,
        "url": "https://www.unicode.org/Public/MAPPINGS/OBSOLETE/EASTASIA/JIS/JIS0212.TXT",
    },
}
