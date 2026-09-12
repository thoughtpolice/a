# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", depot = "shims")

# Single files of dotnet/runtime at the release tag, rather than the whole
# source tarball: only a handful are used, and raw files are byte-stable
# where GitHub's generated tarballs have not always been. Each is
# `:<file name>` (or the name RENAMED gives a file whose name another
# already has); the key is its path in the repository.
FILES = {
    "LICENSE.TXT": "cfc21f5e8bd655ae997eec916138b707b1d290b83272c02a95c9f821b8c87310",
    "src/libraries/System.Private.CoreLib/src/Resources/Strings.resx": "9b01cd133bcac2c1686ad528a6d15ebb301236cedfbfb8e1731b782c61ca24ef",
    "src/libraries/System.Private.CoreLib/src/System/DateTime.Unix.cs": "b40db81957a7c6f73b659b174bac8d4ac0e37e7baf0665d651db1a18d640d812",
    "src/libraries/System.Private.CoreLib/src/System/DateTime.cs": "eae45a6e36abc69387962a956f1280da3f4a548f2413c9a15bf1e9d5336f5688",
    "src/libraries/System.Private.CoreLib/src/System/DateTimeOffset.NonAndroid.cs": "5d29939d9d3d28da92197131b1f3825b30b24688fd2411d70eed958d4774d97f",
    "src/libraries/System.Private.CoreLib/src/System/DateTimeOffset.cs": "c39c0ab6b733f0aefe27819e314b165e153420ce4c762070d78313a974a5334e",
    "src/libraries/System.Private.CoreLib/src/System/Diagnostics/Stopwatch.Unix.cs": "3f30a54c482fc26866d3c20c54d471db28d31c90b42a8f22cd9bdf3ef922827b",
    "src/libraries/System.Private.CoreLib/src/System/Diagnostics/Stopwatch.cs": "8ee76eff6d199d65064dd6e8b29e05b95722e670a8af8dd048c6d7fb84957955",
    "src/libraries/System.Private.CoreLib/src/System/Half.cs": "30a0f5ebc2b58d405723c65b8835daa21022567f75ca547bf725c95f824ac6c8",
    "src/libraries/System.Private.CoreLib/src/System/Int128.cs": "59d54ce19e7062d8d0a9b509693129a2a893a25b21583b15df30b58c32e506e8",
    "src/libraries/System.Private.CoreLib/src/System/Lazy.cs": "c771c75afdf01889f0e92bdb5e4a5cc29840fda9a559be751c43fbd5d0d3b3fe",
    "src/libraries/System.Private.CoreLib/src/System/LazyOfTTMetadata.cs": "6c5763c6da1e7f2e0a28e2a4339130c09d464a5d056ebf8970aab5656f95a765",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/BigIntegerCalculator.Shared.cs": "d37de560168f913482a8f7bcdc7b5e5925da78f3a6fc8b11b085c6e1909837c2",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IAdditionOperators.cs": "53ab052418ca90091af4efc92dd1903b58c15dbd5e47d96f27aaf694d70f32c7",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IBinaryInteger.cs": "07a1ef2f30b57223da115a556c749145495be4e8542144a66292bad47038830f",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IBinaryNumber.cs": "44a9e0e3c8cdf9d08465dbad7ebeba52d4de3887860f2e161db721052521b947",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IDecrementOperators.cs": "e1b58a210729b8f7c8a4572d154b0c1abfd311407fb45896669bd29ef0388498",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IDivisionOperators.cs": "0a4eefa8ca8330f4a1eec40017319dd874dfd3fa183f8aef2c21dc99e4ed173f",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IExponentialFunctions.cs": "852a9caf2dddb838bdb95ceea8c90cdd8b7c2c1aa349d1c358efd33627b98e00",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IFloatingPoint.cs": "7f99c10df2c0e15b03e3452b27e2ba15c7cb6cf639cd1600cc432b3b132fe8b3",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IFloatingPointIeee754.cs": "415a6f6353a4c3ec2c9674627d5edaf01df0a5badb1e2d65c9eb1c732256d814",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IIncrementOperators.cs": "0239098231455f5725187f2254350961e463c211d5c6a77c327e61d24eaa4495",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/ILogarithmicFunctions.cs": "0cabb6362804a47f516ecf73d7a4a0533f77ee49f550c3d6ca30cc4137ea5dc3",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IMultiplyOperators.cs": "79bdeccfae4703138189b4de3abc5ff076ac1562cfc6a9bdf7455162d3ffd222",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/INumber.cs": "f2e3845fbfebb0ecea6e92634f1093da72b5b872ff0fa9a462b681ca4fbb8527",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/INumberBase.cs": "b052023bddb5e3b37a9a5a0da5810ecd8b7ae1769fac6612fdbf0199a9384be5",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/ISubtractionOperators.cs": "ee28988ece86481a71388e01e9e52d496dcef19c7d1e97515a31ef97a414c8f8",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/ITrigonometricFunctions.cs": "9054b255243860a09d019053cfee8cd1ccc74022dca776824db4e73d015ebc58",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/IUnaryNegationOperators.cs": "241a4f72f86544861900ed8163c0a7c7f732c22832c8b6ec5ea1d7526c32e4b5",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Matrix3x2.cs": "a01fd6cf3362c7c794ec90fb792c71947a85996cd80a20941bf559f1dd03f8bb",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Matrix4x4.cs": "577a1e1574ee6c24334dddf6e4396ea5173e87966b5dcd774601a1e5b9040781",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Plane.Extensions.cs": "712230ac79de3d1a735cfb75cc135f9fbaa1be331206c582193b58a4240b029a",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Plane.cs": "ed8464328861ca61b9722fcd93b0a7b11a6f09426669b6f55949cbd8e0d9ae18",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Quaternion.Extensions.cs": "5a4b35c16cfa6f75b6cafa313a21462694df84846220fd7dd0253186589febf2",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Quaternion.cs": "18f94759fdbac2956b409bf2c8d3b1758d5b2f9032bbfe9f623fba012205375d",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Vector2.Extensions.cs": "a382784fbb6611cb6e11f86c3db0f587a0e5826433e649c804e18d9fd9ac5202",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Vector2.cs": "8a8c5f5bd1dfff08d4aea0694d26b951e1991fa27ab4e9f440f435342b051415",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Vector3.Extensions.cs": "f875f246527ac85b39548bc336758ac7366c1f1876e44aee9cad397bc9389501",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Vector3.cs": "a01fd14d0d72531405f3bdad6b50f6763cd28dbf318e52f9be4e51182791f6e3",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Vector4.Extensions.cs": "6ba5b752b0c4cc303c0000825712ccfeca96c56bf1219296a72afc89e7249d80",
    "src/libraries/System.Private.CoreLib/src/System/Numerics/Vector4.cs": "947d57e406b1832c6409bdd1e0b4d5003f5fea610140c29c5a9cc0950306209e",
    "src/libraries/System.Private.CoreLib/src/System/Runtime/Intrinsics/Scalar.cs": "5b764b291536ce931c20ea8da1d812b2b86fb45b6c48f71d2d3d9f2eeae8ab3a",
    "src/libraries/System.Private.CoreLib/src/System/ThrowHelper.cs": "bdf8473f791b00c36240d83dc42beec9da2e6e4c57b9cecb5271d4c143212f53",
    "src/libraries/System.Private.CoreLib/src/System/TimeSpan.cs": "6746cf1817b7236af0e0b96d9d4aea7727c9aa64623da435f736073cb213fef1",
    "src/libraries/System.Private.CoreLib/src/System/UInt128.cs": "2248b41257b0d36a7c27e0ac5c92836710ecb2c2263ce825f497a7269b665365",
    "src/libraries/System.Collections/ref/System.Collections.cs": "0163a13eb9a04a5435b214cdfe431543a39a3ea7ebbd221ab03c1a8004fe0c54",
    "src/libraries/System.Linq/ref/System.Linq.cs": "5a2fbabd7f12179a675caf9af8f5ce75a07b1216e0d3a9ff3b64f24705005be2",
    "src/libraries/System.Memory/ref/System.Memory.cs": "5e0264c13f2d275a4b735369672dcd8d5105fd6642c1320c8b064bd80db8bff9",
    "src/libraries/System.Numerics.Vectors/ref/System.Numerics.Vectors.cs": "5fc3a3fc2c3dd3b8060df6688248b98efd11a97e41a1bd91548aa33d734a71ba",
    "src/libraries/System.Runtime.InteropServices/ref/System.Runtime.InteropServices.cs": "69429069addcb55e698a697bde517d8aa76d7109df079b68a408f8e76efdb76e",
    "src/libraries/System.Runtime.Intrinsics/ref/System.Runtime.Intrinsics.cs": "4a13a9e90bc0f8a978a559ed745c1cd8f90ffe9211b384d8533c6fcb776dc1b5",
    "src/libraries/System.Runtime/ref/System.Runtime.cs": "62885e59f30f070daf5033cac78e4510563e46851a4c8dbc4eaf6675c623a017",
    "src/libraries/System.Threading/ref/System.Threading.cs": "f16e2f27dcf324bdd9fdd569f350afa483ba8261d4e4542dccd6d3435d0f6544",
    "src/libraries/System.Runtime.Numerics/ref/System.Runtime.Numerics.cs": "7fb4edfd9785b44158e15339bb88f388bef53b17d6b9d20f1b95baa85015239b",
    "src/libraries/System.Runtime.Numerics/src/Resources/Strings.resx": "028730cee5e7a5b0de2d57e3ea51e4faa4dd1aad4c3c0da4249c2a0030bc85e9",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigInteger.RentedBuffer.cs": "7f9e4879e3ba37a2bd85343084650adfd5f59e2f8dea1a609320609ed1c1468d",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigInteger.cs": "14b1d173509a9af8bd3ae118f09ae1957cbfd573651adb08ebf306d36f64a1a0",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigIntegerCalculator.Bitwise.cs": "44ad8bcf40ac1082288ba7e34eaa2cf733a2d49a3aadaabf941e7c9d3e6d8cba",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigIntegerCalculator.DivRem.cs": "86086c5a9ff5ff0b807101a78f4fb26bbcba10d65fb7af4fd536c401a1f25b34",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigIntegerCalculator.FastReducer.cs": "ee91451d2fa0d26874a5a173f946703e760c17f15e4d81b0fbece4bf42cf5820",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigIntegerCalculator.GcdInv.cs": "c68b652f8517b74328824e742adf49f931db71139da6729989d581d393fa623c",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigIntegerCalculator.PowMod.cs": "5574b82982cd9e409a71e87adf0e1e6a2ad5cbab3c796e6610ac57a5b170b307",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigIntegerCalculator.ShiftRot.cs": "9f40056e00daf9a1b5cc386e641cd9712e01a4c8d92b9a42cbf8709972bc9830",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigIntegerCalculator.SquMul.cs": "3dd96a11fb1c23b3b15baecb0474af941db82c4dae299dac008786aae647b43e",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/BigIntegerCalculator.Utils.cs": "c2b26490ff11bedb9c758aa852ac7e20092fc664158d194cdb688ddfeab2aab1",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/Complex.Generic.cs": "c58a71c2cd15607e8c3c7f0698b767a379e6ab734423c58fa14084ac476ccebf",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/Complex.cs": "7ade85c9f1a808e83f63ad0cbdea11bd32b81b17a90f39f1fec3f9fab945e878",
    "src/libraries/System.Runtime.Numerics/src/System/Numerics/NumericsHelpers.cs": "a96e1294bd727e0e50409d8a2027e22334e4513ca8c1b2b179c42fb8a2cb39f5",
}

RENAMED = {
    "src/libraries/System.Runtime.Numerics/src/Resources/Strings.resx": "Numerics.Strings.resx",
}

[
    depot.http_file(
        name = RENAMED.get(
            path,
            path.split("/")[-1],
        ),
        sha256 = sha256,
        urls = ["https://raw.githubusercontent.com/dotnet/runtime/v{}/{}".format(
            pkg.version(),
            path,
        )],
        visibility = ["PUBLIC"],
    )
    for path, sha256 in FILES.items()
]

# Patches of those sources, unified diffs of the file each names, which
# coresurface applies before compiling them into the gameplay CoreLib
# (each says why).
PATCHES = [
    "BigInteger.cs.patch",
    "BigIntegerCalculator.GcdInv.cs.patch",
    "BigIntegerCalculator.ShiftRot.cs.patch",
    "Matrix3x2.cs.patch",
    "Matrix4x4.cs.patch",
]

[
    depot.export_file(
        name = patch,
        src = "patches/" + patch,
        visibility = ["PUBLIC"],
    )
    for patch in PATCHES
]
