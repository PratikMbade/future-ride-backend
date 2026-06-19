import { PackageInfo } from "../types/package";

export const packageInfo:PackageInfo[] = [
  {
    packageNumber: 1,
    name: "Package1",
    amount: 5,
  },
  {
    packageNumber: 2,
    name: "Package2",
    amount: 10,
  },
  {
    packageNumber: 3,
    name: "Package3",
    amount: 20,
  },
  {
    packageNumber: 4,
    name: "Package4",
    amount: 40,
  },
  {
    packageNumber: 5,
    name: "Package5",
    amount: 80,
  },
  {
    packageNumber: 6,
    name: "Package6",
    amount: 160,
  },
  {
    packageNumber: 7,
    name: "Package7",
    amount: 320,
  },
  {
    packageNumber: 8,
    name: "Package8",
    amount: 640,
  },
  {
    packageNumber: 9,
    name: "Package9",
    amount: 1280,
  },
  {
    packageNumber: 10,
    name: "Package10",
    amount: 2560,
  },
    {
    packageNumber: 11,
    name: "Package11",
    amount: 5120,
  },
    {
    packageNumber: 12,
    name: "Package12",
    amount: 10240,
  },
];

export const getPackageInfo = (packageNumber: number) =>
       packageInfo.find((pkg) => pkg.packageNumber === packageNumber);