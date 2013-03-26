/// Copyright (c) 2012 Ecma International.  All rights reserved. 
/// Ecma International makes this code available under the terms and conditions set
/// forth on http://hg.ecmascript.org/tests/test262/raw-file/tip/LICENSE (the 
/// "Use Terms").   Any redistribution of this code must retain the above 
/// copyright and this notice and otherwise comply with the Use Terms.
/**
 * @path ch15/15.4/15.4.4/15.4.4.17/15.4.4.17-7-b-8.js
 * @description Array.prototype.some - deleting own property causes index property not to be visited on an Array-like object
 */


function testcase() {
        var accessed = false;
        function callbackfn(val, idx, obj) {
            accessed = true;
            return idx === 1;
        }
        var arr = { length: 2 };

        Object.defineProperty(arr, "1", {
            get: function () {
                return 6.99;
            },
            configurable: true
        });

        Object.defineProperty(arr, "0", {
            get: function () {
                delete arr[1];
                return 0;
            },
            configurable: true
        });

        return !Array.prototype.some.call(arr, callbackfn) && accessed;
    }
runTestCase(testcase);